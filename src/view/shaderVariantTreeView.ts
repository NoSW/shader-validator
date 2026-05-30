import * as vscode from 'vscode';
import { CancellationToken, DocumentSymbol, DocumentSymbolRequest, DocumentUri, LanguageClient, ProtocolNotificationType, ProtocolRequestType, Range, SymbolInformation, SymbolKind, TextDocumentIdentifier, TextDocumentItem, TextDocumentRegistrationOptions } from 'vscode-languageclient/node';
import { resolveVSCodeVariables, ShaderLanguageClient } from '../client';

interface ShaderVariantSerialized {
    url: DocumentUri,
    shadingLanguage: string,
    entryPoint: string,
    stage: string | null,
    defines: Object,
    includes: string[],
}

function shaderVariantToSerialized(url: DocumentUri, languageId: string, e: ShaderVariant) : ShaderVariantSerialized {
    return {
        url: url,
        shadingLanguage: languageId,
        entryPoint: e.name,
        stage: (e.stage.stage === ShaderStage.auto) ? null : ShaderStage[e.stage.stage],
        defines: Object.fromEntries(e.defines.defines.map(e => [e.label, e.value])),
        includes: e.includes.includes.map(e => resolveVSCodeVariables(e.include))
    };
}
// Notification from client to change shader variant
interface DidChangeShaderVariantParams {
    shaderVariant: ShaderVariantSerialized | null
}
interface DidChangeShaderVariantRegistrationOptions extends TextDocumentRegistrationOptions {}

const didChangeShaderVariantNotification = new ProtocolNotificationType<DidChangeShaderVariantParams, DidChangeShaderVariantRegistrationOptions>('textDocument/didChangeShaderVariant');

// Request from server to send file active variant.
interface ShaderVariantParams extends TextDocumentIdentifier {}
interface ShaderVariantRegistrationOptions extends TextDocumentRegistrationOptions {}

interface ShaderVariantResponse {
    shaderVariant: ShaderVariantSerialized | null,
}
const shaderVariantRequest = new ProtocolRequestType<ShaderVariantParams, ShaderVariantResponse, never, void, ShaderVariantRegistrationOptions>('textDocument/shaderVariant');


export type ShaderVariantDefine = {
    kind: 'define',
    label: string,
    value: string,
};

export type ShaderVariantDefineList = {
    kind: 'defineList',
    defines: ShaderVariantDefine[],
};

export type ShaderVariantInclude = {
    kind: 'include',
    include: string,
};

export type ShaderVariantIncludeList = {
    kind: 'includeList',
    includes: ShaderVariantInclude[],
};

export enum ShaderStage {
    auto,
    vertex,
    fragment,
    compute,
    tesselationControl,
    tesselationEvaluation,
    mesh,
    task,
    geometry,
    rayGeneration,
    closestHit,
    anyHit,
    callable,
    miss,
    intersect,
}

export type ShaderVariantStage = {
    kind: 'stage',
    stage: ShaderStage,
};

// This should be shadervariant.
export type ShaderVariant = {
    kind: 'variant';
    uri: vscode.Uri;
    name: string;
    isActive: boolean;
    // Per variant data
    stage: ShaderVariantStage;
    defines: ShaderVariantDefineList;
    includes: ShaderVariantIncludeList;
};

export type ShaderVariantFile = {
    kind: 'file',
    uri: vscode.Uri,
    variants: ShaderVariant[],
};

export type ShaderEntryPoint = {
    entryPoint: string,
    range: vscode.Range,
};

// --- Grouped display nodes (computed from ShaderVariantFile.variants; not persisted) ---
// The panel groups a file's permutations by entry point. Each entryGroup shows the shared stage,
// the defines common to ALL its permutations, the shared includes, and a 'defines' list with one
// node per permutation. The active checkbox lives on the permutation node, which shows only the
// defines that differ from the group's common defines. These nodes use contextValues that do not
// match any package.json menu 'when' clause, so they carry no manual add/edit/delete inline icons.
export type ShaderReadonlyDefine = { kind: 'readonlyDefine', label: string, value: string };
export type ShaderReadonlyInclude = { kind: 'readonlyInclude', include: string };
export type ShaderGroupStage = { kind: 'groupStage', stage: ShaderStage };
export type ShaderCommonDefineList = { kind: 'commonDefineList', defines: ShaderReadonlyDefine[] };
export type ShaderGroupIncludeList = { kind: 'groupIncludeList', includes: ShaderReadonlyInclude[] };
export type ShaderPermutation = {
    kind: 'permutation',
    variant: ShaderVariant,             // underlying full permutation (drives active state & server notify)
    label: string,
    deltaDefines: ShaderReadonlyDefine[],
};
export type ShaderPermutationList = { kind: 'permutationList', permutations: ShaderPermutation[] };
export type ShaderEntryGroup = {
    kind: 'entryGroup',
    uri: vscode.Uri,
    name: string,
    permutationCount: number,
    stageNode: ShaderGroupStage,
    commonDefineList: ShaderCommonDefineList,
    includeList: ShaderGroupIncludeList,
    permutationList: ShaderPermutationList,
};

export type ShaderVariantNode = ShaderVariant | ShaderVariantFile | ShaderVariantDefineList | ShaderVariantIncludeList | ShaderVariantDefine | ShaderVariantInclude | ShaderVariantStage
    | ShaderEntryGroup | ShaderGroupStage | ShaderCommonDefineList | ShaderGroupIncludeList | ShaderPermutationList | ShaderPermutation | ShaderReadonlyDefine | ShaderReadonlyInclude;

// Configuration file schema used by the shader-validator.variantFolder import feature.
// A config describes the variants of one shader (single-file form) or several (multi-file form).
export interface ShaderVariantConfigVariant {
    entryPoint: string,
    stage?: string | null,
    defines?: { [key: string]: string | number },
    includes?: string[],
}
export interface ShaderVariantConfigFile {
    file?: string,
    language?: string,
    // Common defines/includes applied to every variant of this file. A variant's own defines/
    // includes take precedence on conflict. Lets a config factor out macros shared by all variants.
    defines?: { [key: string]: string | number },
    includes?: string[],
    variants: ShaderVariantConfigVariant[],
}
export interface ShaderVariantConfigMultiple {
    files: ShaderVariantConfigFile[],
}
export type ShaderVariantConfig = ShaderVariantConfigFile | ShaderVariantConfigMultiple;

function validateConfigVariants(variants: any, context: string): void {
    if (!Array.isArray(variants)) {
        throw new Error(`${context} must have a 'variants' array.`);
    }
    for (let i = 0; i < variants.length; i++) {
        let variant = variants[i];
        if (typeof variant !== 'object' || variant === null || typeof variant.entryPoint !== 'string' || variant.entryPoint.length === 0) {
            throw new Error(`${context} variant #${i} must have a non-empty string 'entryPoint'.`);
        }
    }
}

// Parse & validate a shader variant config file content (JSON). Throws Error on invalid input.
export function parseShaderVariantConfig(text: string): ShaderVariantConfig {
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : e}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error("Expected a JSON object with a 'variants' or 'files' field.");
    }
    if (Array.isArray(parsed.files)) {
        parsed.files.forEach((file: any, i: number) => validateConfigVariants(file?.variants, `'files' entry #${i}`));
        return parsed as ShaderVariantConfigMultiple;
    }
    if (Array.isArray(parsed.variants)) {
        validateConfigVariants(parsed.variants, "config");
        return parsed as ShaderVariantConfigFile;
    }
    throw new Error("Expected a 'variants' array (single-file form) or a 'files' array (multi-file form).");
}

// Base name (file name without folder) of a path using forward or back slashes.
function getBaseName(p: string): string {
    let normalized = p.replace(/\\/g, '/');
    let lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
}

// Map a config stage string to the ShaderStage enum. Unknown / null / undefined => auto.
function stageFromString(stage: string | null | undefined): ShaderStage {
    if (stage === null || stage === undefined) {
        return ShaderStage.auto;
    }
    let value = ShaderStage[stage as keyof typeof ShaderStage];
    return (typeof value === 'number') ? value : ShaderStage.auto;
}

// Convert a parsed config into a list of ShaderVariant attached to the given uri. All imported
// variants start inactive. openedBaseName (file name with extension) selects the matching entry
// in the multi-file form.
export function configToVariants(uri: vscode.Uri, config: ShaderVariantConfig, openedBaseName: string): ShaderVariant[] {
    let fileConfig: ShaderVariantConfigFile | undefined;
    let files = (config as ShaderVariantConfigMultiple).files;
    if (Array.isArray(files)) {
        fileConfig = files.find(f => f.file !== undefined && getBaseName(f.file) === openedBaseName);
        if (!fileConfig && files.length === 1) {
            fileConfig = files[0];
        }
    } else {
        fileConfig = config as ShaderVariantConfigFile;
    }
    if (!fileConfig || !Array.isArray(fileConfig.variants)) {
        return [];
    }
    // File-level common defines/includes are applied to every variant; a variant's own values
    // take precedence over the common ones on key (define) or path (include) conflict.
    let commonDefines = fileConfig.defines || {};
    let commonIncludes = fileConfig.includes || [];
    return fileConfig.variants.map((variant: ShaderVariantConfigVariant): ShaderVariant => {
        // Merge defines: common first, then the variant's own (variant overrides on key conflict).
        let mergedDefines = new Map<string, string>();
        for (let [label, value] of Object.entries(commonDefines)) {
            mergedDefines.set(label, String(value));
        }
        if (variant.defines) {
            for (let [label, value] of Object.entries(variant.defines)) {
                mergedDefines.set(label, String(value));
            }
        }
        let defines: ShaderVariantDefine[] = Array.from(mergedDefines, ([label, value]): ShaderVariantDefine => {
            return { kind: 'define', label: label, value: value };
        });
        // Merge includes: common then variant, de-duplicated while preserving order.
        let seenIncludes = new Set<string>();
        let includes: ShaderVariantInclude[] = [];
        for (let include of [...commonIncludes, ...(variant.includes || [])]) {
            if (!seenIncludes.has(include)) {
                seenIncludes.add(include);
                includes.push({ kind: 'include', include: include });
            }
        }
        return {
            kind: 'variant',
            uri: uri,
            name: variant.entryPoint,
            isActive: false,
            stage: { kind: 'stage', stage: stageFromString(variant.stage) },
            defines: { kind: 'defineList', defines: defines },
            includes: { kind: 'includeList', includes: includes },
        };
    });
}

// Stable identity of a variant including its defines & includes. Needed because several variants
// of the same shader often share entry point & stage and differ only by their defines (e.g. UE
// permutations), so name+stage alone cannot tell them apart.
export function variantSignature(variant: ShaderVariant): string {
    return JSON.stringify({
        name: variant.name,
        stage: variant.stage.stage,
        defines: variant.defines.defines.map(d => [d.label, d.value]),
        includes: variant.includes.includes.map(i => i.include),
    });
}

// Merge several parsed configs into one de-duplicated variant list for the opened shader. Used to
// fold the many single-permutation JSON files an engine dumps (one per entry point x permutation)
// into a single set. Single-file configs whose 'file' targets a different shader are skipped;
// multi-file configs are matched by openedBaseName inside configToVariants. Identical permutations
// (same variantSignature) are collapsed.
export function mergeVariantConfigs(uri: vscode.Uri, configs: ShaderVariantConfig[], openedBaseName: string): ShaderVariant[] {
    let merged: ShaderVariant[] = [];
    let seen = new Set<string>();
    for (let config of configs) {
        let isMultiFile = Array.isArray((config as ShaderVariantConfigMultiple).files);
        if (!isMultiFile) {
            let file = (config as ShaderVariantConfigFile).file;
            if (file && getBaseName(file).toLowerCase() !== openedBaseName.toLowerCase()) {
                continue; // single-file config describing a different shader
            }
        }
        for (let variant of configToVariants(uri, config, openedBaseName)) {
            let signature = variantSignature(variant);
            if (!seen.has(signature)) {
                seen.add(signature);
                merged.push(variant);
            }
        }
    }
    return merged;
}

// Plain (testable) grouping of a file's permutations by entry point. Permutations sharing an entry
// point + stage are grouped; `commonDefines` are the (label,value) pairs identical across ALL of
// them, `includes` the includes shared by all, and each permutation's `deltaDefines` are the defines
// that differ from the common set. First-seen order is preserved.
export type EntryGroupData = {
    name: string,
    stage: ShaderStage,
    commonDefines: { label: string, value: string }[],
    includes: string[],
    permutations: { variant: ShaderVariant, deltaDefines: { label: string, value: string }[] }[],
};
export function groupVariantsByEntryPoint(variants: ShaderVariant[]): EntryGroupData[] {
    let order: string[] = [];
    let groups = new Map<string, ShaderVariant[]>();
    for (let variant of variants) {
        let key = `${variant.name} ${variant.stage.stage}`;
        let bucket = groups.get(key);
        if (!bucket) { bucket = []; groups.set(key, bucket); order.push(key); }
        bucket.push(variant);
    }
    return order.map((key): EntryGroupData => {
        let permutations = groups.get(key)!;
        // Common defines: label present with identical value in every permutation.
        let common = new Map<string, string>(permutations[0].defines.defines.map(d => [d.label, d.value]));
        for (let i = 1; i < permutations.length; i++) {
            let m = new Map(permutations[i].defines.defines.map(d => [d.label, d.value]));
            for (let [label, value] of [...common]) {
                if (m.get(label) !== value) { common.delete(label); }
            }
        }
        // Common includes: present in every permutation.
        let commonIncludes: Set<string> | null = null;
        for (let permutation of permutations) {
            let set = new Set(permutation.includes.includes.map(i => i.include));
            if (commonIncludes === null) { commonIncludes = set; }
            else { for (let include of [...commonIncludes]) { if (!set.has(include)) { commonIncludes.delete(include); } } }
        }
        return {
            name: permutations[0].name,
            stage: permutations[0].stage.stage,
            commonDefines: [...common].map(([label, value]) => ({ label, value })),
            includes: commonIncludes ? [...commonIncludes] : [],
            permutations: permutations.map(variant => ({
                variant: variant,
                deltaDefines: variant.defines.defines
                    .filter(d => common.get(d.label) !== d.value)
                    .map(d => ({ label: d.label, value: d.value })),
            })),
        };
    });
}

const shaderVariantTreeKey : string = 'shader-validator.shader-variant-tree-key';

export class ShaderVariantTreeDataProvider implements vscode.TreeDataProvider<ShaderVariantNode> {

    private onDidChangeTreeDataEmitter: vscode.EventEmitter<ShaderVariantNode | undefined | void> = new vscode.EventEmitter<ShaderVariantNode | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ShaderVariantNode | undefined | void> = this.onDidChangeTreeDataEmitter.event;

    // using vscode.Uri as key does not match well with Memento state storage...
    private files: Map<string, ShaderVariantFile>;
    private tree: vscode.TreeView<ShaderVariantNode>;
    private server: ShaderLanguageClient;
    private decorator: Map<string, vscode.TextEditorDecorationType>;
    private workspaceState: vscode.Memento;
    private shaderEntryPointList: Map<string, ShaderEntryPoint[]>;
    private asyncGoToShaderEntryPoint: Map<vscode.Uri, string>;
    // Cached recursive listing of *.json files under the resolved variantFolder (rebuilt on open &
    // when the setting changes; reused while switching variants to avoid re-walking the tree).
    private jsonFileCache: { root: string, files: vscode.Uri[] } | null = null;
    // Cached per-file grouped projection (entry-point groups) shown in the panel. Stable object
    // identity preserves tree expansion/checkbox state; invalidated only when a file's variants
    // change (membership/defines), not on a plain active toggle. Built lazily by getChildren.
    private groupCache: Map<string, ShaderEntryGroup[]> = new Map();

    private load() {
        let variants : ShaderVariantFile[] = this.workspaceState.get<ShaderVariantFile[]>(shaderVariantTreeKey, []);
        this.files = new Map(variants.map((e : ShaderVariantFile) => {
            // Seems that serialisation is breaking something, so this is required for uri & range to behave correctly.
            e.uri = vscode.Uri.from(e.uri);
            for (let variant of e.variants) {
                variant.uri = vscode.Uri.from(variant.uri);
            }
            return [e.uri.path, e];
        }));
    }
    private save() {
        let array = Array.from(this.files.values());
        this.workspaceState.update(shaderVariantTreeKey, array);
    }

    constructor(context: vscode.ExtensionContext, server: ShaderLanguageClient) {
        this.workspaceState = context.workspaceState;
        this.files = new Map;
        this.load();
        this.shaderEntryPointList = new Map;
        this.server = server;
        this.tree = vscode.window.createTreeView<ShaderVariantNode>("shader-validator-variants", {
            treeDataProvider: this
            // TODO: drag and drop for better ux.
            //dragAndDropController:
        });
        this.asyncGoToShaderEntryPoint = new Map;
        this.tree.onDidChangeCheckboxState(async (e: vscode.TreeCheckboxChangeEvent<ShaderVariantNode>) => {
            for (let [node, checkboxState] of e.items) {
                if (node.kind === 'permutation') {
                    let variant = node.variant;
                    if (checkboxState === vscode.TreeItemCheckboxState.Checked) {
                        await this.activateVariantWithRefresh(variant);
                    } else {
                        variant.isActive = false; // unchecked
                        let file = this.files.get(variant.uri.path);
                        if (file) {
                            this.refresh(file, file);
                        }
                    }
                }
            }
            this.notifyVariantChanged();
            this.save();
            this.updateDecorations();
        });
        this.decorator = new Map;
        const supportedLangIds = ShaderLanguageClient.getSupportedLangId();
        for (var supportedLangId of supportedLangIds) {
            this.decorator.set(supportedLangId, vscode.window.createTextEditorDecorationType({
                // Icon
                gutterIconPath: context.asAbsolutePath(`./res/icons/${supportedLangId}-icon.svg`),
                gutterIconSize: "contain",
                // Minimap
                overviewRulerColor: "rgb(0, 174, 255)",
                overviewRulerLane: vscode.OverviewRulerLane.Full,
                rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
                // Border
                borderWidth: '1px',
                borderStyle: 'solid',
            }));
        }
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.addCurrentFile", (): void => {
            if (vscode.window.activeTextEditor && ShaderLanguageClient.isEnabledLangId(vscode.window.activeTextEditor.document.languageId)) {
                this.open(vscode.window.activeTextEditor.document.uri);
            }
            this.save();
        }));
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.addCurrentFileVariant", async () => {
            if (vscode.window.activeTextEditor && ShaderLanguageClient.isEnabledLangId(vscode.window.activeTextEditor.document.languageId)) {
                let entryPoint = await this.promptEntryPoint();
                if (entryPoint) {
                    let stage = await this.promptShaderStage();
                    if (stage) {
                        let uri = vscode.window.activeTextEditor.document.uri;
                        this.openOrAddVariant(uri, {
                            kind: 'variant',
                            uri: uri,
                            name: entryPoint,
                            isActive: true,
                            stage: {
                                kind: 'stage',
                                stage: stage
                            },
                            defines: {
                                kind: 'defineList',
                                defines:[]
                            },
                            includes: {
                                kind: 'includeList',
                                includes:[]
                            },
                        });
                    }
                }
            }
            this.save();
        }));
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.addMenu", async (node: ShaderVariantNode) => {
            await this.add(node);
            this.save();
        }));
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.deleteMenu", (node: ShaderVariantNode) => {
            this.delete(node);
            this.save();
        }));
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.editMenu", async (node: ShaderVariantNode) => {
            await this.edit(node);
            this.save();
        }));
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.gotoShaderEntryPoint", (uri: vscode.Uri, entryPointName: string) => {
            // sometimes, its goes in random place in file... 
            // TODO: Should use regex & read diag region instead.
            let diagnostic = vscode.languages.getDiagnostics().find(([diagUri, diags]) => diagUri === uri);
            
            this.goToShaderEntryPoint(uri, entryPointName, true);
        }));
        // Prepare entry point symbol cache
        for (let editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.scheme === 'file') {
                this.shaderEntryPointList.set(editor.document.uri.path, []);
                this.tryAutoImportVariants(editor.document);
            }
        }
        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
            if (document.uri.scheme === 'file') {
                this.shaderEntryPointList.set(document.uri.path, []);
                this.tryAutoImportVariants(document);
            }
        }));
        // Re-scan open shaders when the variant folder setting changes.
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("shader-validator.variantFolder")) {
                for (let editor of vscode.window.visibleTextEditors) {
                    if (editor.document.uri.scheme === 'file') {
                        this.tryAutoImportVariants(editor.document);
                    }
                }
            }
        }));
        context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
            this.shaderEntryPointList.delete(document.uri.path);
        }));
        context.subscriptions.push(vscode.workspace.onDidRenameFiles(document => {
            for (const fileObj of document.files) {
                const { oldUri, newUri } = fileObj;
                // To update the key in a Map, you need to remove the old key and add the new one.
                const oldPath = oldUri.path;
                const newPath = newUri.path;
                const file = this.files.get(oldPath);
                if (file) {
                    // Update the uri inside the file object
                    file.uri = newUri;
                    // Remove the old key and set the new key
                    this.files.delete(oldPath);
                    this.files.set(newPath, file);
                    this.invalidateGroups(oldPath);
                    this.invalidateGroups(newPath);
                }
                // Also update entry point and async maps
                const entryPoints = this.shaderEntryPointList.get(oldPath);
                if (entryPoints) {
                    this.shaderEntryPointList.delete(oldPath);
                    this.shaderEntryPointList.set(newPath, entryPoints);
                }
                const asyncEntryPoint = this.asyncGoToShaderEntryPoint.get(oldUri);
                if (asyncEntryPoint) {
                    this.asyncGoToShaderEntryPoint.delete(oldUri);
                    this.asyncGoToShaderEntryPoint.set(newUri, asyncEntryPoint);
                }
                this.shaderEntryPointList;
                this.asyncGoToShaderEntryPoint;
            }
        }));
        // Auto-reveal the panel node for the active shader when switching/opening editors.
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => this.revealActiveEditorFile(editor)));
        this.revealActiveEditorFile(vscode.window.activeTextEditor);
        this.onServerStart();
    }
    onServerStart() {
        this.updateDependencies();
    }
    dispose() {
        // Nothing to do here.
    }
    private getActiveVariant() : ShaderVariant | null {
        for (const file of this.files.values()) {
            const activeVariant = file.variants.find((e: ShaderVariant) => e.isActive);
            if (activeVariant) {
                return activeVariant;
            }
        }
        return null;
    }
    private hasActiveVariant(file: ShaderVariantFile) : ShaderVariant | null {
        const activeVariant = file.variants.find((e: ShaderVariant) => e.isActive);
        if (activeVariant) {
            return activeVariant;
        }
        return null;
    }

    private goToShaderEntryPoint(uri: vscode.Uri, entryPointName: string, defer: boolean) {
        let shaderEntryPointList = this.shaderEntryPointList.get(uri.path);
        let entryPoint = shaderEntryPointList?.find(e => e.entryPoint === entryPointName);
        // TOOD: Could instead regex + check regions via vscode.
        if (entryPoint) {
            vscode.commands.executeCommand('vscode.open', uri, <vscode.TextDocumentShowOptions>{
                selection: entryPoint.range
            });
        } else {
            let editor = vscode.window.visibleTextEditors.find(e => e.document.uri === uri);
            if (editor || !defer) {
                // Already opened, but no entry point found.
                vscode.window.showWarningMessage(`Failed to find entry point ${entryPointName} for file ${vscode.workspace.asRelativePath(uri)}`);
            } else {
                // Store request & open the file. Resolve goto on document request
                this.asyncGoToShaderEntryPoint.set(uri, entryPointName);
                vscode.commands.executeCommand('vscode.open', uri, <vscode.TextDocumentShowOptions>{});
            }
        }
    }

    private getFileAndParentNode(node: ShaderVariantNode) : [ShaderVariantFile, ShaderVariantNode | null] | null {
        if (node.kind === 'variant') {
            let file = this.files.get(node.uri.path);
            if (file) {
                return [file, null]; // No parent
            }
        } else if (node.kind === 'define') {
            for (let [_, file] of this.files) {
                for (let variant of file.variants) {
                    let index = variant.defines.defines.indexOf(node);
                    if (index > -1) {
                        return [file, variant.defines];
                    }
                }
            }
        } else if (node.kind === 'defineList') {
            for (let [_, file] of this.files) {
                for (let variant of file.variants) {
                    if (variant.defines === node) {
                        return [file, variant];
                    }
                }
            }
        } else if (node.kind === 'stage') {
            for (let [_, file] of this.files) {
                for (let variant of file.variants) {
                    if (variant.stage === node) {
                        return [file, variant];
                    }
                }
            }
        } else if (node.kind === 'include') {
            for (let [_, file] of this.files) {
                for (let variant of file.variants) {
                    let index = variant.includes.includes.indexOf(node);
                    if (index > -1) {
                        return [file, variant.includes];
                    }
                }
            }
        } else if (node.kind === 'includeList') {
            for (let [_, file] of this.files) {
                for (let variant of file.variants) {
                    if (variant.includes === node) {
                        return [file, variant];
                    }
                }
            }
        }
        console.warn("Failed to find file for node ", node);
        return null;
    }

    public refresh(node: ShaderVariantNode | null, file: ShaderVariantFile | null) {
        this.onDidChangeTreeDataEmitter.fire();
        if (file) {
            this.updateDependency(file);
        } else if (node) {
            let result = this.getFileAndParentNode(node);
            if (result) {
                let [file, parent] = result;
                this.updateDependency(file);
            } else {
                // Something failed here...
                this.updateDependencies();
            }
        }
    }
    public refreshAll() {
        this.onDidChangeTreeDataEmitter.fire();
        this.updateDependencies();
    }
    private notifyVariantChanged() {
        function capitalizeFirstLetter(str: string): string {
            return str.charAt(0).toUpperCase() + str.slice(1);
        }
        // Notify server of change.
        let fileActiveVariant = this.getActiveVariant();
        if (fileActiveVariant) {
            // Open document to get language ID.
            // This does not open the document in the editor, only internally.
            vscode.workspace.openTextDocument(fileActiveVariant.uri).then(doc => {
                this.server.sendNotification(didChangeShaderVariantNotification, {
                    // Need this check again here because its async
                    shaderVariant: fileActiveVariant ? shaderVariantToSerialized(
                        this.server.uriAsString(fileActiveVariant.uri), 
                        capitalizeFirstLetter(doc.languageId), // Server expect it with capitalized first letter.
                        fileActiveVariant
                    ) : null,
                });
            });
        } else {
            this.server.sendNotification(didChangeShaderVariantNotification, {
                shaderVariant: null,
            });
        }
        
    }
    private requestDocumentSymbol(uri: vscode.Uri) {
        // TODO: should request inlay hint aswell.
        // This one seems to get symbol from cache without requesting the server...
        //vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", file.uri);
        // This one works, but result is not intercepted by vscode & updated...
        //this.client.sendRequest(DocumentSymbolRequest.type, {
        //    textDocument: {
        //        uri: this.client.code2ProtocolConverter.asUri(file.uri),
        //    }
        //});
        // We have to rely on a dirty hack instead.
        // Need to check this does not break anything
        // Dirty hack to trigger document symbol update
        // Ideally, it should retrigger dependencies aswell.
        // See https://github.com/microsoft/vscode/issues/108722 (Old one https://github.com/microsoft/vscode/issues/71454)

        // Only trigger it if requested by user as it may be a bit invasive.
        let updateSymbolsOnVariantUpdate = vscode.workspace.getConfiguration("shader-validator").get<boolean>("updateSymbolsOnVariantUpdate");
        if (updateSymbolsOnVariantUpdate) {
            let visibleEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.path === uri.path);
            if (visibleEditor) {
                let editor = visibleEditor;
                editor.edit(editBuilder => {
                    for (let iLine = 0; iLine < editor.document.lineCount; iLine++) {
                        // Find first non-empty line to avoid crashing on empty line with negative position.
                        let line = editor.document.lineAt(iLine);
                        if (line.text.length > 0) {
                            const text = line.text;
                            const c = line.range.end.character;
                            // Remove last character of first line and add it back.
                            editBuilder.delete(new vscode.Range(iLine, c-1, iLine, c));
                            editBuilder.insert(new vscode.Position(iLine, c), text[c-1]);
                            break;
                        }
                    }
                    // All empty lines means no symbols !
                });
            }
        }
    }
    private updateDependency(file: ShaderVariantFile) {
        // When editing variant, might need to send it if holding an active one.
        if (this.hasActiveVariant(file))  {
            this.notifyVariantChanged();
        }
        // Symbols might have changed, so request them as we use this to compute symbols.
        this.requestDocumentSymbol(file.uri);
    }
    public onDocumentSymbols(uri: vscode.Uri, symbols: vscode.DocumentSymbol[]) {
        // TODO:TREE: need to recurse child as well.
        this.shaderEntryPointList.set(uri.path, symbols.filter(symbol => symbol.kind === vscode.SymbolKind.Function).map(symbol => {
            return {
                entryPoint: symbol.name, 
                range: symbol.selectionRange
            };
        }));
        // Solve async request for goto.
        let entryPoint = this.asyncGoToShaderEntryPoint.get(uri);
        if (entryPoint) {
            this.asyncGoToShaderEntryPoint.delete(uri);
            this.goToShaderEntryPoint(uri, entryPoint, false);
        }
        this.updateDecorations();
    }
    private updateDependencies() {
        for (let [_, file] of this.files) {
            this.updateDependency(file);
        }
    }

    public getTreeItem(element: ShaderVariantNode): vscode.TreeItem {
        if (element.kind === 'variant') {
            let item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
            // Need to use a middleware command because item is not updated on collapse change.
            item.command = {
                title: "Go to variant",
                command: 'shader-validator.gotoShaderEntryPoint',
                arguments: [
                    element.uri,
                    element.name
                ]
            };
            item.description = `[${element.defines.defines.map(d => d.label).join(",")}]`;
            item.tooltip = `Shader variant ${element.name}`;
            item.checkboxState = element.isActive ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'file') {
            let item = new vscode.TreeItem(vscode.workspace.asRelativePath(element.uri), vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${element.variants.length}`;
            item.resourceUri = element.uri;
            item.tooltip = `File ${element.uri.fsPath}`;
            item.iconPath = vscode.ThemeIcon.File;
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'defineList') {
            let item = new vscode.TreeItem("defines", vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${element.defines.length}`;
            item.tooltip = `List of defines`,
            item.iconPath = new vscode.ThemeIcon('keyboard');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'includeList') {
            let item = new vscode.TreeItem("includes", vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${element.includes.length}`;
            item.tooltip = `List of includes`,
            item.iconPath = new vscode.ThemeIcon('files');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'define') {
            let item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            item.description = element.value;
            item.tooltip = `User defined macro ${element.label} with value ${element.value}`,
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'include') {
            let resolvedIncludePath = resolveVSCodeVariables(element.include);
            let item = new vscode.TreeItem(element.include, vscode.TreeItemCollapsibleState.None);
            item.description = resolvedIncludePath;
            item.tooltip = `User include path ${resolvedIncludePath}`,
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'stage') {
            let item = new vscode.TreeItem("stage", vscode.TreeItemCollapsibleState.None);
            item.description = ShaderStage[element.stage];
            item.tooltip = "The shader stage of this variant. If auto is selected, the server will try to guess the stage, or use generic one when supported by API.";
            item.iconPath = new vscode.ThemeIcon('code');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'entryGroup') {
            let item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.command = {
                title: "Go to entry point",
                command: 'shader-validator.gotoShaderEntryPoint',
                arguments: [element.uri, element.name]
            };
            item.description = `${element.permutationCount}`;
            item.tooltip = `Entry point ${element.name} (${element.permutationCount} permutation${element.permutationCount === 1 ? '' : 's'})`;
            item.iconPath = new vscode.ThemeIcon('symbol-function');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'groupStage') {
            let item = new vscode.TreeItem("stage", vscode.TreeItemCollapsibleState.None);
            item.description = ShaderStage[element.stage];
            item.tooltip = "The shader stage shared by this entry point's permutations.";
            item.iconPath = new vscode.ThemeIcon('code');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'commonDefineList') {
            let item = new vscode.TreeItem("common defines", vscode.TreeItemCollapsibleState.Collapsed);
            item.description = `${element.defines.length}`;
            item.tooltip = "Defines shared by every permutation of this entry point.";
            item.iconPath = new vscode.ThemeIcon('keyboard');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'groupIncludeList') {
            let item = new vscode.TreeItem("includes", vscode.TreeItemCollapsibleState.Collapsed);
            item.description = `${element.includes.length}`;
            item.tooltip = "Includes shared by every permutation of this entry point.";
            item.iconPath = new vscode.ThemeIcon('files');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'permutationList') {
            let item = new vscode.TreeItem("defines", vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${element.permutations.length}`;
            item.tooltip = "One entry per permutation; tick one to make it the active variant.";
            item.iconPath = new vscode.ThemeIcon('versions');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'permutation') {
            let hasDelta = element.deltaDefines.length > 0;
            let item = new vscode.TreeItem(element.label, hasDelta ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
            item.command = {
                title: "Go to entry point",
                command: 'shader-validator.gotoShaderEntryPoint',
                arguments: [element.variant.uri, element.variant.name]
            };
            item.description = `[${element.deltaDefines.map(d => `${d.label}=${d.value}`).join(",")}]`;
            item.tooltip = `Permutation of ${element.variant.name}. Tick to make it the active variant.`;
            item.checkboxState = element.variant.isActive ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'readonlyDefine') {
            let item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            item.description = element.value;
            item.tooltip = `Macro ${element.label} = ${element.value}`;
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'readonlyInclude') {
            let resolvedIncludePath = resolveVSCodeVariables(element.include);
            let item = new vscode.TreeItem(element.include, vscode.TreeItemCollapsibleState.None);
            item.description = resolvedIncludePath;
            item.tooltip = `Include path ${resolvedIncludePath}`;
            item.contextValue = element.kind;
            return item;
        } else {
            console.error("Unimplemented kind: ", element);
            return undefined!; // unreachable
        }
    }

    public getChildren(element?: ShaderVariantNode): ShaderVariantNode[] | Thenable<ShaderVariantNode[]> {
        if (!element) {
            return Array.from(this.files.values());
        }
        switch (element.kind) {
            case 'file': return this.getEntryGroups(element);
            case 'entryGroup': return [element.stageNode, element.commonDefineList, element.includeList, element.permutationList];
            case 'commonDefineList': return element.defines;
            case 'groupIncludeList': return element.includes;
            case 'permutationList': return element.permutations;
            case 'permutation': return element.deltaDefines;
            // Leaf & legacy kinds have no children in the grouped view.
            default: return [];
        }
    }
    // Build (or reuse cached) entry-point groups for a file. Cached objects keep stable identity so
    // tree expansion & checkbox state survive refreshes; invalidated on variant-set change.
    private getEntryGroups(file: ShaderVariantFile): ShaderEntryGroup[] {
        let cached = this.groupCache.get(file.uri.path);
        if (cached) {
            return cached;
        }
        let groups = groupVariantsByEntryPoint(file.variants).map((group): ShaderEntryGroup => ({
            kind: 'entryGroup',
            uri: file.uri,
            name: group.name,
            permutationCount: group.permutations.length,
            stageNode: { kind: 'groupStage', stage: group.stage },
            commonDefineList: {
                kind: 'commonDefineList',
                defines: group.commonDefines.map((d): ShaderReadonlyDefine => ({ kind: 'readonlyDefine', label: d.label, value: d.value })),
            },
            includeList: {
                kind: 'groupIncludeList',
                includes: group.includes.map((i): ShaderReadonlyInclude => ({ kind: 'readonlyInclude', include: i })),
            },
            permutationList: {
                kind: 'permutationList',
                permutations: group.permutations.map((p, index): ShaderPermutation => ({
                    kind: 'permutation',
                    variant: p.variant,
                    label: `#${index}`,
                    deltaDefines: p.deltaDefines.map((d): ShaderReadonlyDefine => ({ kind: 'readonlyDefine', label: d.label, value: d.value })),
                })),
            },
        }));
        this.groupCache.set(file.uri.path, groups);
        return groups;
    }
    private invalidateGroups(filePath: string) {
        this.groupCache.delete(filePath);
    }
    // Required for TreeView.reveal (used to auto-reveal a file node when its editor becomes active).
    public getParent(element: ShaderVariantNode): ShaderVariantNode | undefined {
        if (element.kind === 'file') {
            return undefined;
        }
        if (element.kind === 'entryGroup') {
            return this.files.get(element.uri.path);
        }
        for (let groups of this.groupCache.values()) {
            for (let group of groups) {
                if (element === group.stageNode || element === group.commonDefineList || element === group.includeList || element === group.permutationList) {
                    return group;
                }
                if (group.permutationList.permutations.some(p => p === element)) {
                    return group.permutationList;
                }
                for (let perm of group.permutationList.permutations) {
                    if (perm.deltaDefines.some(d => d === element)) {
                        return perm;
                    }
                }
                if (group.commonDefineList.defines.some(d => d === element)) {
                    return group.commonDefineList;
                }
                if (group.includeList.includes.some(i => i === element)) {
                    return group.includeList;
                }
            }
        }
        return undefined;
    }
    // Reveal (and select, without stealing focus) the panel node for a file.
    private revealFile(file: ShaderVariantFile) {
        this.tree.reveal(file, { select: true, focus: false, expand: true }).then(undefined, () => {});
    }
    // If the given editor is a tracked shader file, reveal its node in the panel.
    private revealActiveEditorFile(editor: vscode.TextEditor | undefined) {
        if (!editor || editor.document.uri.scheme !== 'file') {
            return;
        }
        let file = this.files.get(editor.document.uri.path);
        if (file) {
            this.revealFile(file);
        }
    }

    public open(uri: vscode.Uri): void {
        this.openOrAddVariant(uri, null);
    }
    public openOrAddVariant(uri: vscode.Uri, variant: ShaderVariant | null): void {
        if (uri.scheme !== 'file') {
            return;
        }
        // If adding active variant, remove all currently active ones.
        if (variant) {
            if (variant.isActive) {
                for (let [url, file] of this.files) {
                    let needRefresh = false;
                    for (let otherVariant of file.variants) {
                        if (otherVariant.isActive) {
                            needRefresh = true;
                            otherVariant.isActive = false;
                        }
                    }
                    if (needRefresh) {
                        // Refresh file & all its childs
                        this.refresh(file, file);
                    }
                }
            }
        }
        let file = this.files.get(uri.path);
        if (!file) {
            let newFile : ShaderVariantFile = {
                kind: 'file',
                uri: uri,
                variants: variant ? [variant] : []
            };
            this.files.set(uri.path, newFile);
            this.invalidateGroups(uri.path);
            this.refresh(null, this.files.get(uri.path)!); // This has to be here
        } else if (variant) {
            file.variants.push(variant);
            this.invalidateGroups(uri.path);
            this.refresh(null, file);
        }
    }
    public close(uri: vscode.Uri): void {
        let file = this.files.get(uri.path);
        if (file) {
            // We keep it if some variants where defied.
            if (file.variants.length === 0) {
                this.files.delete(uri.path);
                this.invalidateGroups(uri.path);
                this.refreshAll();
            }
        }
    }
    // Auto-import variants for a shader document from the shader-validator.variantFolder setting.
    // Guards language & scheme then runs the async import as fire-and-forget.
    private tryAutoImportVariants(document: vscode.TextDocument): void {
        if (document.uri.scheme !== 'file' || !ShaderLanguageClient.isEnabledLangId(document.languageId)) {
            return;
        }
        this.autoImportVariants(document.uri).catch(e => console.warn("Shader variant auto-import failed", e));
    }
    // Recursively collect every *.json file under a folder, caching the listing per resolved root.
    // The folder is a tree of engine-dumped JSON configs (e.g. UE ShaderDebugInfo), so nested
    // directories are walked.
    private async collectJsonFiles(folderUri: vscode.Uri): Promise<vscode.Uri[]> {
        if (this.jsonFileCache && this.jsonFileCache.root === folderUri.path) {
            return this.jsonFileCache.files;
        }
        let files: vscode.Uri[] = [];
        let stack: vscode.Uri[] = [folderUri];
        const maxFiles = 200000; // safety bound against pathologically large trees
        while (stack.length > 0 && files.length < maxFiles) {
            let dir = stack.pop()!;
            let entries: [string, vscode.FileType][];
            try {
                entries = await vscode.workspace.fs.readDirectory(dir);
            } catch (e) {
                continue; // unreadable / missing dir, skip
            }
            for (let [name, type] of entries) {
                let child = vscode.Uri.joinPath(dir, name);
                if (type & vscode.FileType.Directory) {
                    stack.push(child);
                } else if ((type & vscode.FileType.File) && name.toLowerCase().endsWith('.json')) {
                    files.push(child);
                }
            }
        }
        this.jsonFileCache = { root: folderUri.path, files };
        return files;
    }
    // Scan the configured variant folder for every JSON config describing the opened shader (all
    // entry points x all permutations, across nested directories) and merge them into one
    // de-duplicated variant list attached to uri. Returns null when no folder is configured or no
    // matching config is found. Logs & skips unreadable/invalid files; never throws. `forceRescan`
    // rebuilds the cached file listing (used on open so freshly dumped files are seen); switching
    // variants reuses the cache for speed.
    private async loadVariantsFromConfig(uri: vscode.Uri, forceRescan: boolean = false): Promise<ShaderVariant[] | null> {
        if (uri.scheme !== 'file') {
            return null;
        }
        let variantFolder = vscode.workspace.getConfiguration("shader-validator").get<string>("variantFolder");
        if (!variantFolder || variantFolder.length === 0) {
            return null;
        }
        let resolvedFolder = resolveVSCodeVariables(variantFolder);
        if (resolvedFolder.length === 0) {
            return null;
        }
        let folderUri = vscode.Uri.file(resolvedFolder);
        if (forceRescan) {
            this.jsonFileCache = null;
        }
        let jsonFiles = await this.collectJsonFiles(folderUri);

        // Pre-filter by file name so we only parse JSONs named after the opened shader (engines name
        // each dump <ShaderName>.json / <ShaderName>_DebugCompile.json), avoiding parsing the tree.
        let openedBaseName = getBaseName(uri.path);                 // e.g. FXAAShader.usf
        let dotIndex = openedBaseName.lastIndexOf('.');
        let stemLower = (dotIndex > 0 ? openedBaseName.substring(0, dotIndex) : openedBaseName).toLowerCase();
        let configs: ShaderVariantConfig[] = [];
        for (let fileUri of jsonFiles) {
            let jsonName = getBaseName(fileUri.path).toLowerCase();
            if (!jsonName.startsWith(stemLower)) {
                continue;
            }
            let rest = jsonName.slice(stemLower.length);            // "" never (ends .json); ".json", "_debugcompile.json", ".variants.json"...
            if (!(rest === '.json' || rest.startsWith('.') || rest.startsWith('_'))) {
                continue; // e.g. fxaashaderhelper.json -> reject
            }
            try {
                let bytes = await vscode.workspace.fs.readFile(fileUri);
                configs.push(parseShaderVariantConfig(new TextDecoder('utf-8').decode(bytes)));
            } catch (e) {
                let message = `Failed to import shader variants from ${fileUri.fsPath}: ${e instanceof Error ? e.message : e}`;
                console.warn(message);
                this.server.log(message);
            }
        }
        if (configs.length === 0) {
            return null; // No config for this shader.
        }
        let merged = mergeVariantConfigs(uri, configs, openedBaseName);
        return merged.length > 0 ? merged : null;
    }
    // Load the config(s) for a shader and replace its variants in the tree. The config is the
    // source of truth: re-opening the shader re-syncs the tree. Rescans the folder so freshly
    // dumped permutations are picked up.
    private async autoImportVariants(uri: vscode.Uri): Promise<void> {
        let variants = await this.loadVariantsFromConfig(uri, true);
        if (variants) {
            this.applyImportedVariants(uri, variants);
        }
    }
    // Replace the variants of a file with imported ones, only if they actually differ (avoids
    // churn & dirty edits when re-opening). Preserves the active selection when a matching
    // variant still exists.
    private applyImportedVariants(uri: vscode.Uri, variants: ShaderVariant[]): void {
        let file = this.files.get(uri.path);
        // Change detection by full signature, ignoring active state & order-independent of it.
        let project = (vs: ShaderVariant[]) => JSON.stringify(vs.map(variantSignature));
        if (file && project(file.variants) === project(variants)) {
            return; // Nothing changed.
        }
        // Preserve active selection if a matching variant still exists in the new set.
        let previousActive = file ? file.variants.find(v => v.isActive) : undefined;
        if (previousActive) {
            let previousSignature = variantSignature(previousActive);
            let match = variants.find(v => variantSignature(v) === previousSignature);
            if (match) {
                match.isActive = true;
            }
        }
        if (file) {
            file.variants = variants;
        } else {
            file = { kind: 'file', uri: uri, variants: variants };
            this.files.set(uri.path, file);
        }
        this.invalidateGroups(uri.path);
        this.save();
        this.onDidChangeTreeDataEmitter.fire();
        this.notifyVariantChanged();
        this.updateDecorations();
        // If the freshly-imported file is the one in the active editor, reveal it (the import is
        // async, so the open-triggered reveal may have run before the file existed in the panel).
        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.path === uri.path) {
            this.revealActiveEditorFile(vscode.window.activeTextEditor);
        }
    }
    // Activate the clicked variant, re-reading its config from disk first
    // (auto-refresh-config-before-switch). This keeps the switch in sync with the latest config
    // without a file watcher. When no variant folder is configured, loadVariantsFromConfig returns
    // null and this behaves like a plain activation.
    private async activateVariantWithRefresh(clicked: ShaderVariant): Promise<void> {
        let signature = variantSignature(clicked);
        let reloaded = await this.loadVariantsFromConfig(clicked.uri);
        let file = this.files.get(clicked.uri.path);
        if (reloaded && file) {
            let changed = JSON.stringify(file.variants.map(variantSignature)) !== JSON.stringify(reloaded.map(variantSignature));
            if (changed) {
                file.variants = reloaded;
                this.invalidateGroups(file.uri.path);
                this.refresh(file, file); // re-render the refreshed variant set
            }
        }
        // The clicked node may have been replaced by the refresh: re-find it by signature.
        let toActivate = file ? file.variants.find(v => variantSignature(v) === signature) : clicked;
        if (file && !toActivate) {
            vscode.window.showWarningMessage(`The selected shader variant no longer exists in the refreshed config for ${vscode.workspace.asRelativePath(clicked.uri)}.`);
        }
        // Keep a single active variant across all files.
        for (let [, otherFile] of this.files) {
            let needRefresh = false;
            for (let other of otherFile.variants) {
                let shouldBeActive = (toActivate !== undefined && other === toActivate);
                if (other.isActive !== shouldBeActive) {
                    other.isActive = shouldBeActive;
                    needRefresh = true;
                }
            }
            if (needRefresh) {
                this.refresh(otherFile, otherFile);
            }
        }
    }
    async promptEntryPoint() : Promise<string | undefined> {
        return await vscode.window.showInputBox({
            title: "Entry point",
            value: "main",
            prompt: "Select an entry point for your variant. Note that specifying this along the stage might improve performances.",
            placeHolder: "main"
        });
    }
    async promptShaderStage() : Promise<ShaderStage | undefined> {
        let stage = await vscode.window.showQuickPick(
            [
                ShaderStage[ShaderStage.auto],
                ShaderStage[ShaderStage.vertex],
                ShaderStage[ShaderStage.fragment],
                ShaderStage[ShaderStage.compute],
                ShaderStage[ShaderStage.tesselationControl],
                ShaderStage[ShaderStage.tesselationEvaluation],
                ShaderStage[ShaderStage.mesh],
                ShaderStage[ShaderStage.task],
                ShaderStage[ShaderStage.geometry],
                ShaderStage[ShaderStage.rayGeneration],
                ShaderStage[ShaderStage.closestHit],
                ShaderStage[ShaderStage.anyHit],
                ShaderStage[ShaderStage.callable],
                ShaderStage[ShaderStage.miss],
                ShaderStage[ShaderStage.intersect],
            ],
            {
                title: "Shader stage"
            }
        );
        if (stage) {
            return ShaderStage[stage as keyof typeof ShaderStage];
        } else {
            return undefined;
        }
    }
    public async add(node: ShaderVariantNode) {
        if (node.kind === 'file') {
            let entryPoint = await this.promptEntryPoint();
            if (entryPoint) {
                let stage = await this.promptShaderStage();
                if (stage) {
                    node.variants.push({
                        kind: 'variant',
                        uri: node.uri,
                        name: entryPoint,
                        isActive: false,
                        stage: {
                            kind: 'stage',
                            stage: stage
                        },
                        defines: {
                            kind: 'defineList',
                            defines:[]
                        },
                        includes: {
                            kind: 'includeList',
                            includes:[]
                        },
                    });
                    this.invalidateGroups(node.uri.path);
                    this.refresh(node, node);
                }
            }
        } else if (node.kind === 'defineList') {
            let label = await vscode.window.showInputBox({
                title: "Macro label",
                value: "MY_MACRO",
                prompt: "Select a label for you macro.",
                placeHolder: "MY_MACRO"
            });
            if (label) {
                let value = await vscode.window.showInputBox({
                    title: "Macro value",
                    value: "1",
                    prompt: "Select a value for you macro.",
                    placeHolder: "1"
                });
                if (value) {
                    node.defines.push({
                        kind: "define",
                        label: label,
                        value: value,
                    });
                    this.refresh(node, null);
                }
            }
        } else if (node.kind === 'includeList') {
            let include = await vscode.window.showInputBox({
                title: "Include path",
                value: "${workspaceFolder}/",
                prompt: "Select a path for your include.",
                placeHolder: "${workspaceFolder}/"
            });
            if (include) {
                node.includes.push({
                    kind: "include",
                    include: include,
                });
                this.refresh(node, null);
            }
        }
    }
    public async edit(node: ShaderVariantNode) {
        if (node.kind === 'variant') {
            let name = await vscode.window.showInputBox({
                title: "Entry point selection",
                value: node.name,
                prompt: "Select an entry point name for your variant",
                placeHolder: "main"
            });
            if (name) {
                node.name = name;
                this.refresh(node, null);
            }
        } else if (node.kind === 'define') {
            let label = await vscode.window.showInputBox({
                title: "Macro label",
                value: node.label,
                prompt: "Select a label for you macro.",
                placeHolder: "MY_MACRO"
            });
            let value = await vscode.window.showInputBox({
                title: "Macro value",
                value: node.value,
                prompt: "Select a value for you macro.",
                placeHolder: "0"
            });
            if (label) {
                node.label = label;
            }
            if (value) {
                node.value = value;
            }
            if (value || label) {
                this.refresh(node, null);
            }
        } else if (node.kind === 'include') {
            let include = await vscode.window.showInputBox({
                title: "Include path",
                value: node.include,
                prompt: "Select a path for your include.",
                placeHolder: "${workspaceFolder}/"
            });
            if (include) {
                node.include = include;
                this.refresh(node, null);
            }
        } else if (node.kind === 'stage') {
            let stage = await this.promptShaderStage();
            if (stage) {
                node.stage = stage;
                this.refresh(node, null);
            }
        }
    }
    public delete(node: ShaderVariantNode) {
        if (node.kind === 'file') {
            this.files.delete(node.uri.path);
            this.invalidateGroups(node.uri.path);
            this.refreshAll();
        } else if (node.kind === 'variant') {
            let cachedFile = this.files.get(node.uri.path);
            if (cachedFile) {
                let index = cachedFile.variants.indexOf(node);
                if (index > -1) {
                    cachedFile.variants.splice(index, 1);
                    this.invalidateGroups(cachedFile.uri.path);
                    this.refresh(cachedFile, cachedFile);
                }
            }
        } else if (node.kind === 'define') {
            // Dirty remove, might be costly when lot of elements...
            for (let [_, file] of this.files) {
                let found = false;
                for (let variant of file.variants) {
                    let index = variant.defines.defines.indexOf(node);
                    if (index > -1) {
                        variant.defines.defines.splice(index, 1);
                        // Refresh variant for description
                        this.invalidateGroups(file.uri.path);
                        this.refresh(variant, file);
                        found = true;
                        break;
                    }
                }
                if (found) {
                    break;
                }
            }
        } else if (node.kind === 'include') {
            // Dirty remove, might be costly when lot of elements...
            for (let [uri, file] of this.files) {
                let found = false;
                for (let variant of file.variants) {
                    let index = variant.includes.includes.indexOf(node);
                    if (index > -1) {
                        variant.includes.includes.splice(index, 1);
                        this.invalidateGroups(file.uri.path);
                        this.refresh(variant.includes, file);
                        found = true;
                        break;
                    }
                }
                if (found) {
                    break;
                }
            }
        }
    }
    private getDecorator(langId: string) : vscode.TextEditorDecorationType {
        // Use decorator or a default one.
        return this.decorator.get(langId) || vscode.window.createTextEditorDecorationType({
            // Minimap
            overviewRulerColor: "rgb(0, 174, 255)",
            overviewRulerLane: vscode.OverviewRulerLane.Full,
            rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
            // Border
            borderWidth: '1px',
            borderStyle: 'solid',
        });
    }
    private updateDecoration(editor: vscode.TextEditor) {
        let file = this.files.get(editor.document.uri.path);
        let entryPoints = this.shaderEntryPointList.get(editor.document.uri.path);

        let variant = this.getActiveVariant();
        if (file && entryPoints) {
            if (variant) {
                let found = false;
                for (let entryPoint of entryPoints) {
                    if (entryPoint.entryPoint === variant.name) {
                        let decorations : vscode.DecorationOptions[]= [];
                        decorations.push({ range: entryPoint.range, hoverMessage: variant.name });
                        editor.setDecorations(this.getDecorator(editor.document.languageId), decorations);
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    console.info("Entry point not found in ", entryPoints);
                    editor.setDecorations(this.getDecorator(editor.document.languageId), []);
                }
            } else {
                console.info("No active variant ", entryPoints);
                editor.setDecorations(this.getDecorator(editor.document.languageId), []);
            }
        } else {
            editor.setDecorations(this.getDecorator(editor.document.languageId), []);
        }
    }
    private updateDecorations(uri?: vscode.Uri) {
        for (let editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.scheme === 'file') {
                this.updateDecoration(editor);
            }
        }
    }
}