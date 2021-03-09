import { Memoize } from 'typescript-memoize';
import { dirname, isAbsolute, join, relative } from 'path';
import { sync as pkgUpSync } from 'pkg-up';
import { existsSync, pathExistsSync } from 'fs-extra';
import Funnel, { Options as FunnelOptions } from 'broccoli-funnel';
import { UnwatchedDir, WatchedDir } from 'broccoli-source';
import RewritePackageJSON from './rewrite-package-json';
import { todo, unsupported } from '@embroider/core/src/messages';
import { Node } from 'broccoli-node-api';
import mergeTrees from 'broccoli-merge-trees';
import semver from 'semver';
import rewriteAddonTree from './rewrite-addon-tree';
import { mergeWithAppend } from './merges';
import { AddonMeta, NodeTemplateCompiler, debug, PackageCache, Resolver, extensionsPattern } from '@embroider/core';
import Options from './options';
import walkSync from 'walk-sync';
import ObserveTree from './observe-tree';
import type { Options as HTMLBarsOptions } from 'ember-cli-htmlbars';
import { isEmbroiderMacrosPlugin } from '@embroider/macros/src/node';
import { TransformOptions, PluginItem } from '@babel/core';
import V1App from './v1-app';
import modulesCompat from './modules-compat';
import writeFile from 'broccoli-file-creator';
import SynthesizeTemplateOnlyComponents from './synthesize-template-only-components';
import { isEmberAutoImportDynamic } from './detect-ember-auto-import';
import { isCompactReexports } from './detect-compact-reexports';
import { ResolvedDep } from '@embroider/core/src/resolver';
import TemplateCompilerBroccoliPlugin from './template-compiler-broccoli-plugin';

const stockTreeNames = Object.freeze([
  'addon',
  'addon-styles',
  'styles',
  'addon-test-support',
  'test-support',
  'app',
  'public',
  'vendor',
  // 'addon-templates' and 'templates are trees too, but they live inside
  // 'addon' and 'app' and we handle them there.
]);

const dynamicTreeHooks = Object.freeze([
  'treeFor',
  'treeForAddon',
  'treeForAddonTemplates',
  'treeForAddonTestSupport',
  'treeForApp',
  'treeForPublic',
  'treeForStyles',
  'treeForTemplates',
  'treeForTestSupport',
  'treeForVendor',
]);

const appPublicationDir = '_app_';
const fastbootPublicationDir = '_fastboot_';

/**
 * Creating a interface here just to keep the Resolver's structure as it is.
 */
interface ResolverParams {
  root: string;
  modulePrefix: string;
}

export function resolver(params: ResolverParams): V1AddonCompatResolver {
  return new V1AddonCompatResolver(params);
}

class V1AddonCompatResolver implements Resolver {
  params: ResolverParams;

  _parallelBabel: {
    requireFile: string;
    buildUsing: string;
    params: ResolverParams;
  };

  constructor(params: ResolverParams) {
    this.params = params;
    this._parallelBabel = {
      requireFile: __filename,
      buildUsing: 'resolver',
      params,
    };
  }
  astTransformer(_templateCompiler: NodeTemplateCompiler): unknown {
    return;
  }
  dependenciesOf(_moduleName: string): ResolvedDep[] {
    return [];
  }
  absPathToRuntimePath(absPath: string) {
    if (isAbsolute(absPath)) {
      return absPath;
    }
    return join(this.params.modulePrefix, absPath);
  }
  absPathToRuntimeName(absPath: string) {
    return this.absPathToRuntimePath(absPath)
      .replace(extensionsPattern(['.js', '.hbs']), '')
      .replace(/\/index$/, '');
  }
}

// This controls and types the interface between our new world and the classic
// v1 addon instance.
export default class V1Addon {
  constructor(
    protected addonInstance: any,
    protected addonOptions: Required<Options>,
    private app: V1App,
    private packageCache: PackageCache,
    private orderIdx: number
  ) {
    if (addonInstance.registry) {
      this.updateRegistry(addonInstance.registry);
    }
  }

  // this is only defined when there are custom AST transforms that need it
  @Memoize()
  private get templateCompiler(): NodeTemplateCompiler | undefined {
    let htmlbars = this.addonInstance.addons.find((a: any) => a.name === 'ember-cli-htmlbars');
    if (htmlbars) {
      let options = htmlbars.htmlbarsOptions() as HTMLBarsOptions;
      if (options.plugins && options.plugins.ast) {
        // our macros don't run here in stage1
        options.plugins.ast = options.plugins.ast.filter((p: any) => !isEmbroiderMacrosPlugin(p));
        if (options.plugins.ast.length > 0) {
          return new NodeTemplateCompiler({
            compilerPath: options.templateCompilerPath,
            EmberENV: {},
            plugins: options.plugins,
            resolver: this.templateResolver(),
          });
        }
      }
    }
  }

  @Memoize()
  templateResolver(): Resolver {
    return resolver({
      root: this.app.root,
      modulePrefix: this.moduleName,
    });
  }

  private updateRegistry(registry: any) {
    // auto-import gets disabled because we support it natively
    registry.remove('js', 'ember-auto-import-analyzer');

    // here we're replacing the stock template compiler with our own. Ours
    // leaves hbs files as hbs, not js. The only transformation it is supposed
    // to do is applying any custom AST transforms and reserializing the results
    // back to HBS.
    //
    // Even when no AST transforms are registered, we'll still need to register
    // a no-op transform here to avoid an exception coming out of ember-cli like
    // "Addon templates were detected, but there are no template compilers
    // registered".
    registry.remove('template', 'ember-cli-htmlbars');
    registry.add('template', {
      name: 'embroider-addon-templates',
      ext: 'hbs',
      _addon: this,
      toTree(this: { _addon: V1Addon }, tree: Node): Node {
        if (this._addon.templateCompiler) {
          return new TemplateCompilerBroccoliPlugin(tree, this._addon.templateCompiler, 1);
        } else {
          // when there are no custom AST transforms, we don't need to do
          // anything at all.
          return tree;
        }
      },
    });

    if (this.needsCustomBabel()) {
      // there is customized babel behavior needed, so we will leave
      // ember-cli-babel in place, but modify its config so it doesn't do the
      // things we don't want to do in stage1.
      this.updateBabelConfig();
    } else {
      // no custom babel behavior, so we don't run the ember-cli-babel
      // preprocessor at all. We still need to register a no-op preprocessor to
      // prevent ember-cli from emitting a deprecation warning.
      registry.remove('js', 'ember-cli-babel');
      registry.add('js', {
        name: 'embroider-babel-noop',
        ext: 'js',
        toTree(tree: Node) {
          return tree;
        },
      });
    }
  }

  // we need to run custom inline hbs preprocessing if there are custom hbs
  // plugins and there are inline hbs templates
  private needsInlineHBS(): boolean {
    if (!this.templateCompiler) {
      // no custom transforms
      return false;
    }
    if (this.addonInstance.addons.find((a: any) => a.name === 'ember-cli-htmlbars-inline-precompile')) {
      // the older inline template compiler is present
      return true;
    }

    if (
      this.addonInstance.addons.find(
        (a: any) =>
          a.name === 'ember-cli-htmlbars' && semver.satisfies(semver.coerce(a.pkg.version) || a.pkg.version, '>4.0.0')
      )
    ) {
      // a version of ember-cli-htmlbars that natively supports inline hbs is present
      return true;
    }

    return false;
  }

  private needsCustomBabel() {
    if (
      this.addonInstance.addons.find(
        (a: any) =>
          a.name === 'ember-cli-typescript' &&
          semver.satisfies(semver.coerce(a.pkg.version) || a.pkg.version, '>=4.0.0-alpha.1')
      )
    ) {
      // This addon is using ember-cli-typescript 4, which relies on
      // ember-cli-babel to add the TypeScript transform Babel plugin.
      return true;
    }

    if (
      this.addonInstance.options &&
      this.addonInstance.options['ember-cli-babel'] &&
      this.addonInstance.options['ember-cli-babel'].enableTypeScriptTransform
    ) {
      // This addon has explicitly configured ember-cli-babel to add the
      // TypeScript transform Babel plugin.
      return true;
    }

    let babelConfig = this.options.babel as TransformOptions | undefined;
    if (babelConfig && babelConfig.plugins && babelConfig.plugins.length > 0) {
      // this addon has custom babel plugins, so we need to run them here in
      // stage1
      return true;
    }

    // even if there are no custom babel plugins, if we need to do any
    // preprocessing of inline handlebars templates we still need to run the
    // custom babel.
    return this.needsInlineHBS();
  }

  get name(): string {
    return this.packageJSON.name;
  }

  protected get packageJSON() {
    return this.addonInstance.pkg;
  }

  @Memoize()
  get root(): string {
    // addonInstance.root gets modified by a customized "main" or
    // "ember-addon.main" in package.json. We want the real package root here
    // (the place where package.json lives).
    return dirname(pkgUpSync({ cwd: this.addonInstance.root })!);
  }

  @Memoize()
  private get mainModule() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(this.addonInstance.constructor._meta_.modulePath);

    if (typeof mod === 'function') {
      return mod.prototype;
    } else {
      return mod;
    }
  }

  protected get options() {
    if (!this.addonInstance.options) {
      this.addonInstance.options = {};
      return this.addonInstance.options;
    }
    // some addons (like ember-cli-inline-content) assign the *app's* options
    // onto their own this.options. Which means they (accidentally or on
    // purpose), always get the app's babel config, and it means when we try
    // to modify the addon's babel config we're accidentally modifying the
    // app's too.
    //
    // So here we do copying to ensure that we can modify the babel config
    // without altering anybody else. We're not doing cloneDeep because that
    // pulls on our lazy MacrosConfig if it appears in any babel configs here,
    // whereas we want to leave it unevaluated until babel actually uses it.
    let addonOptions =
      typeof this.addonInstance.options == 'function' ? this.addonInstance.options() : this.addonInstance.options;
    let options = Object.assign({}, addonOptions);
    if (options.babel) {
      options.babel = Object.assign({}, options.babel);
      if (options.babel.plugins) {
        options.babel.plugins = options.babel.plugins.slice();
      }
    }
    if (options['ember-cli-babel']) {
      options['ember-cli-babel'] = Object.assign({}, options['ember-cli-babel']);
    }

    if (typeof this.addonInstance.options == 'function') {
      this.addonInstance.options = () => options;
    } else {
      this.addonInstance.options = options;
    }

    return options;
  }

  protected customizes(...treeNames: string[]) {
    return Boolean(
      treeNames.find(treeName => {
        return (
          // customized hook exists in actual code exported from their index.js
          this.mainModule[treeName] ||
          // addon instance doesn't match its own prototype
          (this.addonInstance.__proto__ && this.addonInstance[treeName] !== this.addonInstance.__proto__[treeName])
        );
      })
    );
  }

  @Memoize()
  private hasStockTree(treeName: string): boolean {
    if (this.suppressesTree(treeName)) {
      return false;
    }

    // we need to use this.addonInstance.root instead of this.root here because
    // we're looking for the classic location of the stock tree, and that
    // location is influenced by a customized ember-addon.main in package.json,
    // which is reflected in addonInstance.root.
    return (
      this.addonInstance.treePaths && existsSync(join(this.addonInstance.root, this.addonInstance.treePaths[treeName]))
    );
  }

  hasAnyTrees(): boolean {
    return Boolean(stockTreeNames.find(name => this.hasStockTree(name))) || this.customizes(...dynamicTreeHooks);
  }

  // we keep all these here to ensure that we always apply the same options to
  // the same tree, so that our cache doesn't need to worry about varying
  // options.
  private stockTreeFunnelOptions(treeName: string): FunnelOptions | undefined {
    switch (treeName) {
      case 'addon':
        return {
          exclude: ['styles/**'],
        };
      case 'styles':
        return {
          destDir: '_app_styles_',
        };
      case 'addon-test-support':
        return {
          destDir: 'test-support',
        };
      case 'app':
        return {
          exclude: ['styles/**'],
          destDir: appPublicationDir,
        };
      case 'public':
        return {
          destDir: `public/${this.moduleName}`,
        };
      case 'vendor':
        return {
          destDir: 'vendor',
        };
    }
  }

  protected stockTree(treeName: string): Node {
    return this.throughTreeCache(treeName, 'stock', () => {
      // adjust from the legacy "root" to our real root, because our rootTree
      // uses our real root but the stock trees are defined in terms of the
      // legacy root
      let srcDir = relative(this.root, join(this.addonInstance.root, this.addonInstance.treePaths[treeName]));
      let opts = Object.assign({ srcDir }, this.stockTreeFunnelOptions(treeName));
      return new Funnel(this.rootTree, opts);
    })!;
  }

  @Memoize()
  protected get rootTree(): Node {
    if (this.packageCache.get(this.root).mayRebuild) {
      return new WatchedDir(this.root);
    } else {
      return new UnwatchedDir(this.root);
    }
  }

  @Memoize()
  private get moduleName(): string {
    if (typeof this.addonInstance.moduleName === 'function') {
      return this.addonInstance.moduleName();
    }
    return this.addonInstance.name;
  }

  // applies preprocessors to JS and HBS
  private transpile(tree: Node) {
    tree = this.addonInstance.preprocessJs(tree, '/', this.moduleName, {
      registry: this.addonInstance.registry,
    });
    if (this.addonInstance.shouldCompileTemplates() && this.addonInstance.registry.load('template').length > 0) {
      tree = this.app.preprocessRegistry.preprocessTemplates(tree, {
        registry: this.addonInstance.registry,
      });
    }
    return tree;
  }

  @Memoize()
  protected updateBabelConfig() {
    let packageOptions = this.options;
    let emberCLIBabelInstance = this.addonInstance.addons.find((a: any) => a.name === 'ember-cli-babel');
    let version;

    if (emberCLIBabelInstance) {
      version = emberCLIBabelInstance.pkg.version;
    }

    if (!packageOptions['ember-cli-babel']) {
      packageOptions['ember-cli-babel'] = {};
    }

    if (!packageOptions.babel) {
      packageOptions.babel = {};
    }
    let babelConfig = packageOptions.babel as TransformOptions;

    Object.assign(packageOptions['ember-cli-babel'], {
      compileModules: false,
      disablePresetEnv: true,
      disableDebugTooling: true,
      disableEmberModulesAPIPolyfill: true,
    });

    if (version && semver.satisfies(semver.coerce(version) || version, '^5')) {
      unsupported(`${this.name} is using babel 5. Not installing our custom plugin.`);
      return;
    }

    if (!babelConfig.plugins) {
      babelConfig.plugins = [];
    } else {
      let hadAutoImport = Boolean(babelConfig.plugins.find(isEmberAutoImportDynamic));
      babelConfig.plugins = babelConfig.plugins.filter(babelPluginAllowedInStage1);
      if (hadAutoImport) {
        // if we removed ember-auto-import's dynamic import() plugin, the code
        // may use import() syntax and we need to re-add it to the parser.
        if (version && semver.satisfies(semver.coerce(version) || version, '^6')) {
          babelConfig.plugins.push(require.resolve('babel-plugin-syntax-dynamic-import'));
        } else {
          babelConfig.plugins.push(require.resolve('@babel/plugin-syntax-dynamic-import'));
        }
      }
    }

    if (this.templateCompiler) {
      babelConfig.plugins.push(this.templateCompiler.inlineTransformsBabelPlugin());
    }
  }

  get v2Tree(): Node {
    return this.throughTreeCache(
      // these are all the kinds of trees that ember-cli's tree cache
      // understands. We need them all here because if *any* of these are
      // uncacheable, we want our whole v2 tree to be treated as uncacheable.
      [
        'app',
        'addon',
        'addon-styles',
        'addon-templates',
        'addon-test-support',
        'public',
        'styles',
        'templates',
        'test-support',
        'vendor',
      ],
      'v2Tree',
      () => mergeTrees(this.v2Trees, { overwrite: true })
    );
  }

  // this is split out so that compatibility shims can override it to add more
  // things to the package metadata.
  protected get packageMeta(): Partial<AddonMeta> {
    let built = this.build();
    return mergeWithAppend(built.staticMeta, ...built.dynamicMeta.map(d => d()));
  }

  @Memoize()
  protected get v2Trees() {
    let { trees } = this.build();
    return trees;
  }

  protected throughTreeCache(nameOrNames: string | string[], category: string, fn: () => Node): Node;
  protected throughTreeCache(
    nameOrNames: string | string[],
    category: string,
    fn: () => Node | undefined
  ): Node | undefined {
    let cacheKey: string | undefined;
    if (typeof this.addonInstance.cacheKeyForTree === 'function') {
      let names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
      cacheKey = names.reduce((accum: string | undefined, name) => {
        if (accum == null) {
          // a previous name was uncacheable, so we're entirely uncacheable
          return undefined;
        }
        let key = this.addonInstance.cacheKeyForTree(name);
        if (key) {
          return accum + key;
        } else {
          return undefined;
        }
      }, '');
      if (cacheKey) {
        cacheKey = cacheKey + category;
        let cachedTree = this.app.addonTreeCache.get(cacheKey);
        if (cachedTree) {
          debug('cache hit %s %s %s', this.name, nameOrNames, category);
          return cachedTree;
        }
      }
    }
    debug('cache miss %s %s %s', this.name, nameOrNames, category);
    let tree = fn();
    if (tree && cacheKey) {
      this.app.addonTreeCache.set(cacheKey, tree);
    }
    return tree;
  }

  // In general, we can't reliably run addons' custom `treeFor()` methods,
  // because they recurse in a way that we absolutely don't want.
  //
  // But there is a very common use case that we *can* handle opportunisticaly,
  // which is a treeFor() that's used purely to guard whether `_super` will be
  // called or not.
  private suppressesTree(name: string): boolean {
    if (!this.customizes('treeFor')) {
      return false;
    }
    let origSuper = this.addonInstance._super;
    try {
      this.addonInstance._super = stubbedSuper;
      let result = this.mainModule.treeFor?.call(this.addonInstance, name);
      if (result === markedEmptyTree) {
        // the method returns _super unchanged, so tree is not suppressed and we
        // understand what's going on
        return false;
      }
      if (result == null) {
        // the method nulled out the tree, so we are definitely suppressing
        return true;
      }
      // we can't tell what's really going on, don't suppress and hope for the
      // best
      unsupported(`${this.name} has a custom treeFor() method that is doing some arbitrary broccoli processing.`);
      return false;
    } finally {
      if (this.addonInstance._super === stubbedSuper) {
        this.addonInstance._super = origSuper;
      }
    }
  }

  protected invokeOriginalTreeFor(
    name: string,
    { neuterPreprocessors } = { neuterPreprocessors: false }
  ): Node | undefined {
    return this.throughTreeCache(name, 'original', () => {
      let original;
      try {
        if (neuterPreprocessors) {
          original = this.addonInstance.preprocessJs;
          this.addonInstance.preprocessJs = function (tree: Node) {
            return tree;
          };
        }
        if (this.suppressesTree(name)) {
          return undefined;
        }
        return this.addonInstance._treeFor(name);
      } finally {
        if (neuterPreprocessors) {
          this.addonInstance.preprocessJs = original;
        }
      }
    });
  }

  protected treeForAddon(built: IntermediateBuild): Node | undefined {
    // the extra isEngine condition is because ember-engines injects a
    // treeForAddon method into each engine addon that we really don't need or
    // want to run. Unfortunately there's not a more localized place to patch it
    // out, partly because ember-engines also uses a bogus inheritance strategy
    // (instead of providing a prototype that engine addons can extend it
    // patches things into their instance directly).
    if (this.customizes('treeForAddon', 'treeForAddonTemplates') && !this.isEngine()) {
      let tree = this.invokeOriginalTreeFor('addon', { neuterPreprocessors: true });
      if (tree) {
        tree = modulesCompat(tree);

        // this captures addons that are trying to escape their own package's
        // namespace
        let result = rewriteAddonTree(this.transpile(tree), this.name, this.moduleName);
        built.dynamicMeta.push(result.getMeta);
        return result.tree;
      }
    } else if (this.hasStockTree('addon')) {
      return this.transpile(this.stockTree('addon'));
    }
  }

  protected addonStylesTree(): Node | undefined {
    if (this.customizes('treeForAddonStyles')) {
      return this.invokeOriginalTreeFor('addon-styles');
    } else if (this.hasStockTree('addon-styles')) {
      return this.addonInstance.compileStyles(this.stockTree('addon-styles'));
    }
  }

  protected treeForTestSupport(): Node | undefined {
    if (this.customizes('treeForTestSupport')) {
      todo(`${this.name} has customized the test support tree`);
    } else if (this.hasStockTree('test-support')) {
      // this one doesn't go through transpile yet because it gets handled as
      // part of the consuming app. For example, imports should be relative to
      // the consuming app, not our own package.
      return new Funnel(this.stockTree('test-support'), {
        destDir: `${appPublicationDir}/tests`,
      });
    }
  }

  private buildTreeForAddon(built: IntermediateBuild) {
    let tree = this.treeForAddon(built);
    if (!tree) {
      return;
    }
    let templateOnlyComponents: Node = new SynthesizeTemplateOnlyComponents(tree, ['components']);
    if (!this.addonOptions.staticAddonTrees) {
      let filenames: string[] = [];
      let templateOnlyComponentNames: string[] = [];

      tree = new ObserveTree(tree, outputDir => {
        filenames = walkSync(outputDir, { globs: ['**/*.js', '**/*.hbs'] })
          .map(f => `./${f.replace(/\.js$/i, '')}`)
          .filter(notColocatedTemplate);
      });

      templateOnlyComponents = new ObserveTree(templateOnlyComponents, outputDir => {
        templateOnlyComponentNames = walkSync(outputDir, { globs: ['**/*.js'] }).map(
          f => `./${f.replace(/\.js$/i, '')}`
        );
      });

      built.dynamicMeta.push(() => ({
        'implicit-modules': filenames.concat(templateOnlyComponentNames),
      }));
    }
    built.trees.push(tree);
    built.trees.push(templateOnlyComponents);
  }

  private buildAddonStyles(built: IntermediateBuild) {
    let addonStylesTree = this.addonStylesTree();
    if (addonStylesTree) {
      let discoveredFiles: string[] = [];
      let tree = new ObserveTree(addonStylesTree, outputPath => {
        discoveredFiles = walkSync(outputPath, { globs: ['**/*.css'], directories: false });
      });
      built.trees.push(tree);
      built.dynamicMeta.push(() => {
        return {
          'implicit-styles': discoveredFiles.map(f => `./${f}`),
        };
      });
    }
  }

  private buildTreeForStyles(built: IntermediateBuild) {
    let tree;
    if (this.customizes('treeForStyles')) {
      // the user's tree returns their own styles with no "app/styles" wrapping
      // around, which is actually what we want
      tree = this.invokeOriginalTreeFor('styles');
      if (tree) {
        tree = new Funnel(tree, {
          destDir: '_app_styles_',
          getDestinationPath(path) {
            return path.replace(/^app\/styles\//, '');
          },
        });
      }
    } else if (this.hasStockTree('styles')) {
      tree = this.stockTree('styles');
    }
    if (tree) {
      built.trees.push(tree);
    }
  }

  private buildAddonTestSupport(built: IntermediateBuild) {
    let addonTestSupportTree;
    if (this.customizes('treeForAddonTestSupport')) {
      let original = this.invokeOriginalTreeFor('addon-test-support', { neuterPreprocessors: true });
      if (original) {
        let { tree, getMeta } = rewriteAddonTree(original, this.name, this.moduleName);
        addonTestSupportTree = this.transpile(tree);
        built.dynamicMeta.push(getMeta);
      }
    } else if (this.hasStockTree('addon-test-support')) {
      addonTestSupportTree = this.transpile(this.stockTree('addon-test-support'));
    }
    if (addonTestSupportTree) {
      if (!this.addonOptions.staticAddonTestSupportTrees) {
        let filenames: string[] = [];
        addonTestSupportTree = new ObserveTree(addonTestSupportTree, outputPath => {
          filenames = walkSync(outputPath, { globs: ['**/*.js', '**/*.hbs'] }).map(f => `./${f.replace(/.js$/i, '')}`);
        });
        built.dynamicMeta.push(() => ({
          'implicit-test-modules': filenames,
        }));
      }
      built.trees.push(addonTestSupportTree);
    }
  }

  private maybeSetDirectoryMeta(built: IntermediateBuild, tree: Node, localDir: string, key: keyof AddonMeta): Node {
    // unforunately Funnel doesn't create destDir if its input exists but is
    // empty. And we want to only put the app-js key in package.json if
    // there's really a directory for it to point to. So we need to monitor
    // the output and use dynamicMeta.
    let files: AddonMeta['app-js'];
    built.dynamicMeta.push(() => {
      if (files) {
        return { [key]: files };
      } else {
        return {};
      }
    });
    return new ObserveTree(tree, (outputPath: string) => {
      let dir = join(outputPath, localDir);
      if (existsSync(dir)) {
        files = Object.fromEntries(
          walkSync(dir, { globs: ['**/*.js', '**/*.hbs'] }).map(f => [`./${f}`, `./${localDir}/${f}`])
        );
      } else {
        files = undefined;
      }
    });
  }

  private buildTestSupport(built: IntermediateBuild) {
    let tree = this.treeForTestSupport();
    if (tree) {
      tree = this.maybeSetDirectoryMeta(built, tree, appPublicationDir, 'app-js');
      built.trees.push(tree);
    }
  }

  private buildTreeForApp(built: IntermediateBuild) {
    let appTree;
    if (this.customizes('treeForApp', 'treeForTemplates')) {
      let original = this.invokeOriginalTreeFor('app');
      if (original) {
        appTree = new Funnel(original, {
          destDir: appPublicationDir,
        });
      }
    } else if (this.hasStockTree('app')) {
      appTree = this.stockTree('app');
    }

    if (appTree) {
      // this one doesn't go through transpile yet because it gets handled as
      // part of the consuming app.
      appTree = this.maybeSetDirectoryMeta(built, appTree, appPublicationDir, 'app-js');
      built.trees.push(appTree);
    }

    if (
      typeof this.addonInstance.isDevelopingAddon === 'function' &&
      this.addonInstance.isDevelopingAddon() &&
      this.addonInstance.hintingEnabled()
    ) {
      let hintTree = this.addonInstance.jshintAddonTree();
      if (hintTree) {
        hintTree = this.maybeSetDirectoryMeta(
          built,
          new Funnel(hintTree, { destDir: appPublicationDir }),
          appPublicationDir,
          'app-js'
        );
        built.trees.push(hintTree);
      }
    }
  }

  private buildTreeForFastBoot(built: IntermediateBuild) {
    let tree;

    if (this.customizes('treeForFastBoot')) {
      // Arguably, it would be more correct to always create the new Funnel,
      // because the fastboot directory could be created *after* our build starts.
      // But that would result in hundreds of additional trees, even though the
      // vast majority of addons aren't changing and don't have fastboot
      // directories. So I'm pretty comfortable with the optimization. It means
      // that an addon author who creates a brand new fastboot directory in a v1
      // packages will need to restart their build. (Really we hope new addons
      // will be authored in v2 instead soon anyway, and they won't need the
      // concept of "fastboot directory" because they can use the macro system to
      // conditionally import some things only in fastboot.)
      if (pathExistsSync(join(this.root, 'fastboot'))) {
        tree = new Funnel(this.rootTree, { srcDir: 'fastboot' });
      }
      tree = this.addonInstance.treeForFastBoot(tree);
      if (tree) {
        tree = new Funnel(tree, { destDir: fastbootPublicationDir });
      }
    } else {
      if (pathExistsSync(join(this.root, 'fastboot'))) {
        tree = new Funnel(this.rootTree, { srcDir: 'fastboot', destDir: fastbootPublicationDir });
      }
    }

    if (tree) {
      // this one doesn't go through transpile yet because it gets handled as
      // part of the consuming app.
      tree = this.maybeSetDirectoryMeta(built, tree, fastbootPublicationDir, 'fastboot-js');
      built.trees.push(tree);
    }
  }

  private buildPublicTree(built: IntermediateBuild) {
    let publicTree;
    // the extra isEngine condition is here because ember-engines injects a
    // customized treeForPublic into every engine addon. We don't want or need
    // it to run.
    if (this.customizes('treeForPublic') && !this.isEngine()) {
      let original = this.invokeOriginalTreeFor('public');
      if (original) {
        publicTree = new Funnel(original, {
          destDir: 'public',
        });
      }
    } else if (this.hasStockTree('public')) {
      publicTree = this.stockTree('public');
    }
    if (publicTree) {
      let publicAssets: { [filename: string]: string } = {};
      publicTree = new ObserveTree(publicTree, (outputPath: string) => {
        publicAssets = {};
        for (let filename of walkSync(join(outputPath, 'public'))) {
          if (!filename.endsWith('/')) {
            publicAssets[`public/${filename}`] = filename;
          }
        }
      });
      built.trees.push(publicTree);
      built.dynamicMeta.push(() => ({ 'public-assets': publicAssets }));
    }
  }

  private buildVendorTree(built: IntermediateBuild) {
    if (this.customizes('treeForVendor')) {
      // We don't have any particular opinions about the structure inside
      // vendor, so even when it's customized we can just use the customized
      // one.
      let tree = this.invokeOriginalTreeFor('vendor');
      if (tree) {
        built.trees.push(
          new Funnel(tree, {
            destDir: 'vendor',
          })
        );
      }
    } else if (this.hasStockTree('vendor')) {
      built.trees.push(this.stockTree('vendor'));
    }
  }

  private isEngine() {
    return typeof this.addonInstance.getEngineConfigContents === 'function';
  }

  private buildEngineConfig(built: IntermediateBuild) {
    if (!this.isEngine()) {
      return;
    }
    // this addon is an engine, so it needs its own config/environment.js.
    // ember-engines always emits a separate inline (not-meta-tag) config for
    // fastboot, so we mimic that behavior here.
    //
    // getEngineConfigContents is an arbitrary customizable module, so we can't
    // easily rewrite it to live inside our conditional, so it's safer in a
    // separate module.
    built.trees.push(writeFile('config/_environment_browser_.js', this.addonInstance.getEngineConfigContents()));
    built.trees.push(
      writeFile(
        'config/environment.js',
        `
      import { macroCondition, getGlobalConfig, importSync } from '@embroider/macros';
      let config;
      if (macroCondition(getGlobalConfig().fastboot?.isRunning)){
        config = ${JSON.stringify(this.addonInstance.engineConfig(this.app.env, {}), null, 2)};
      } else {
        config = importSync('./_environment_browser_.js').default;
      }
      export default config;
    `
      )
    );
  }

  private buildPackageJSON(built: IntermediateBuild) {
    let packageJSONRewriter = new RewritePackageJSON(
      this.rootTree,
      () => this.packageMeta,
      this.packageCache.get(this.root).packageJSON
    );
    built.trees.push(packageJSONRewriter);
  }

  @Memoize()
  private build(): IntermediateBuild {
    let built = new IntermediateBuild();
    built.staticMeta['order-index'] = this.orderIdx;

    if (this.options.lazyLoading && this.options.lazyLoading.enabled) {
      built.staticMeta['lazy-engine'] = true;
    }

    if (this.moduleName !== this.name) {
      built.staticMeta['renamed-packages'] = {
        [this.moduleName]: this.name,
      };
    }

    this.buildTreeForAddon(built);
    this.buildAddonStyles(built);
    this.buildTreeForStyles(built);
    this.buildAddonTestSupport(built);
    this.buildTestSupport(built);
    this.buildTreeForApp(built);
    this.buildTreeForFastBoot(built);
    this.buildPublicTree(built);
    this.buildVendorTree(built);
    this.buildEngineConfig(built);
    this.buildPackageJSON(built);
    return built;
  }
}

export interface V1AddonConstructor {
  new (
    addonInstance: any,
    options: Required<Options>,
    app: V1App,
    packageCache: PackageCache,
    orderIdx: number
  ): V1Addon;
}

class IntermediateBuild {
  trees: Node[] = [];
  staticMeta: { [metaField: string]: any } = {};
  dynamicMeta: (() => Partial<AddonMeta>)[] = [];
}

function babelPluginAllowedInStage1(plugin: PluginItem) {
  if (isEmbroiderMacrosPlugin(plugin)) {
    // the point of @embroider/macros is that it's allowed to stay in v2
    // addon publication format, so it doesn't need to run here in stage1.
    // We always run it in stage3.
    return false;
  }

  if (NodeTemplateCompiler.isInlinePrecompilePlugin(plugin)) {
    // Similarly, the inline precompile plugin must not run in stage1. We
    // want all templates uncompiled. Instead, we will be adding our own
    // plugin that only runs custom AST transforms inside inline
    // templates.
    return false;
  }

  if (isEmberAutoImportDynamic(plugin)) {
    // We replace ember-auto-import's implementation of dynamic import(), so we
    // need to stop its plugin from rewriting those.
    return false;
  }

  if (isCompactReexports(plugin)) {
    // We don't want to replace re-exports at this stage, since that will turn
    // an `export` statement into a `define`, which is handled in Stage 3
    return false;
  }

  return true;
}

function notColocatedTemplate(path: string) {
  return !/^\.\/components\/.*\.hbs$/.test(path);
}

const markedEmptyTree = new UnwatchedDir(process.cwd());

const stubbedSuper = () => {
  return markedEmptyTree;
};

stubbedSuper.treeFor = () => {
  return markedEmptyTree;
};
