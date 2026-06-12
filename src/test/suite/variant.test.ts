import * as assert from 'assert';

import * as vscode from 'vscode';
import {
	parseShaderVariantConfig,
	configToVariants,
	mergeVariantConfigs,
	mergeVariantConfigsWithSignatures,
	groupVariantsByEntryPoint,
	variantSignature,
	formatPermutationValueSummary,
	ShaderStage,
} from '../../view/shaderVariantTreeView';

suite('Variant Import Test Suite', () => {
	const uri = vscode.Uri.file('/D:/shaders/FXAAShader.usf');

	test('Parse & convert single-file config', () => {
		let json = JSON.stringify({
			file: "D:/shaders/FXAAShader.usf",
			language: "hlsl",
			variants: [
				{
					entryPoint: "FxaaPS",
					stage: "fragment",
					defines: { DIM_ALPHA_CHANNEL: "0", FXAA_PRESET: 1 }, // numeric value coerced to string
					includes: ["${workspaceFolder}/inc"]
				}
			]
		});
		let config = parseShaderVariantConfig(json);
		let variants = configToVariants(uri, config, "FXAAShader.usf");
		assert.strictEqual(variants.length, 1);
		let variant = variants[0];
		assert.strictEqual(variant.name, "FxaaPS");
		assert.strictEqual(variant.uri, uri);
		assert.strictEqual(variant.isActive, false);
		assert.strictEqual(variant.stage.stage, ShaderStage.fragment);
		assert.deepStrictEqual(
			variant.defines.defines.map(d => [d.label, d.value]),
			[["DIM_ALPHA_CHANNEL", "0"], ["FXAA_PRESET", "1"]]
		);
		assert.deepStrictEqual(variant.includes.includes.map(i => i.include), ["${workspaceFolder}/inc"]);
	});

	test('Missing or unknown stage falls back to auto', () => {
		let config = parseShaderVariantConfig(JSON.stringify({
			variants: [
				{ entryPoint: "A" },
				{ entryPoint: "B", stage: null },
				{ entryPoint: "C", stage: "notAStage" }
			]
		}));
		let variants = configToVariants(uri, config, "FXAAShader.usf");
		assert.strictEqual(variants.length, 3);
		for (let variant of variants) {
			assert.strictEqual(variant.stage.stage, ShaderStage.auto);
		}
	});

	test('Multi-file config selects matching entry by base name', () => {
		let config = parseShaderVariantConfig(JSON.stringify({
			files: [
				{ file: "D:/other/ShaderA.usf", variants: [{ entryPoint: "MainA", stage: "compute" }] },
				{ file: "Z:/x/FXAAShader.usf", variants: [{ entryPoint: "FxaaPS", stage: "fragment" }] }
			]
		}));
		let variants = configToVariants(uri, config, "FXAAShader.usf");
		assert.strictEqual(variants.length, 1);
		assert.strictEqual(variants[0].name, "FxaaPS");
		assert.strictEqual(variants[0].stage.stage, ShaderStage.fragment);
	});

	test('Multi-file config with no match and multiple entries yields nothing', () => {
		let config = parseShaderVariantConfig(JSON.stringify({
			files: [
				{ file: "D:/other/ShaderA.usf", variants: [{ entryPoint: "MainA" }] },
				{ file: "D:/other/ShaderB.usf", variants: [{ entryPoint: "MainB" }] }
			]
		}));
		let variants = configToVariants(uri, config, "FXAAShader.usf");
		assert.strictEqual(variants.length, 0);
	});

	test('Invalid JSON throws', () => {
		assert.throws(() => parseShaderVariantConfig("{ not json "));
	});

	test('Missing variants array throws', () => {
		assert.throws(() => parseShaderVariantConfig(JSON.stringify({ file: "x.usf" })));
	});

	test('Variant without entryPoint throws', () => {
		assert.throws(() => parseShaderVariantConfig(JSON.stringify({ variants: [{ stage: "fragment" }] })));
	});

	test('All defines are imported, including common ones (no stripping)', () => {
		let defines: { [k: string]: string } = {};
		for (let i = 0; i < 150; i++) {
			defines[`MACRO_${i}`] = String(i % 2);
		}
		let config = parseShaderVariantConfig(JSON.stringify({
			variants: [{ entryPoint: "FxaaPS", stage: "fragment", defines }]
		}));
		let variants = configToVariants(uri, config, "FXAAShader.usf");
		assert.strictEqual(variants[0].defines.defines.length, 150);
	});

	test('variantSignature distinguishes same entryPoint+stage variants that differ only by defines', () => {
		// The UE case: every FXAA variant is FxaaPS/fragment, differing only by defines.
		let config = parseShaderVariantConfig(JSON.stringify({
			variants: [
				{ entryPoint: "FxaaPS", stage: "fragment", defines: { DIM_ALPHA_CHANNEL: "0", FXAA_PRESET: "0" } },
				{ entryPoint: "FxaaPS", stage: "fragment", defines: { DIM_ALPHA_CHANNEL: "1", FXAA_PRESET: "0" } },
				{ entryPoint: "FxaaPS", stage: "fragment", defines: { DIM_ALPHA_CHANNEL: "0", FXAA_PRESET: "0" } }
			]
		}));
		let variants = configToVariants(uri, config, "FXAAShader.usf");
		// Different defines => different signatures.
		assert.notStrictEqual(variantSignature(variants[0]), variantSignature(variants[1]));
		// Identical content => identical signatures.
		assert.strictEqual(variantSignature(variants[0]), variantSignature(variants[2]));
	});

	test('File-level common defines merge into every variant; variant overrides on conflict', () => {
		let config = parseShaderVariantConfig(JSON.stringify({
			file: "FXAAShader.usf",
			language: "hlsl",
			defines: { COMMON_A: "1", FXAA_PRESET: "0" },
			includes: ["/common/inc"],
			variants: [
				{ entryPoint: "FxaaPS", stage: "fragment", defines: { FXAA_PRESET: "2", DIM: "1" }, includes: ["/variant/inc"] },
				{ entryPoint: "FxaaPS2", stage: "fragment" }
			]
		}));
		let variants = configToVariants(uri, config, "FXAAShader.usf");
		assert.strictEqual(variants.length, 2);

		// Variant 0: common + own, with the variant's FXAA_PRESET overriding the common value.
		let d0 = new Map(variants[0].defines.defines.map(d => [d.label, d.value]));
		assert.strictEqual(d0.get("COMMON_A"), "1");
		assert.strictEqual(d0.get("FXAA_PRESET"), "2");
		assert.strictEqual(d0.get("DIM"), "1");
		assert.deepStrictEqual(variants[0].includes.includes.map(i => i.include), ["/common/inc", "/variant/inc"]);

		// Variant 1 (no own defines/includes): just the common ones.
		let d1 = new Map(variants[1].defines.defines.map(d => [d.label, d.value]));
		assert.strictEqual(d1.get("COMMON_A"), "1");
		assert.strictEqual(d1.get("FXAA_PRESET"), "0");
		assert.deepStrictEqual(variants[1].includes.includes.map(i => i.include), ["/common/inc"]);
	});

	test('Common includes are de-duplicated against variant includes (order preserved)', () => {
		let config = parseShaderVariantConfig(JSON.stringify({
			includes: ["/inc/a", "/inc/b"],
			variants: [{ entryPoint: "M", includes: ["/inc/b", "/inc/c"] }]
		}));
		let variants = configToVariants(uri, config, "FXAAShader.usf");
		assert.deepStrictEqual(variants[0].includes.includes.map(i => i.include), ["/inc/a", "/inc/b", "/inc/c"]);
	});

	test('mergeVariantConfigs folds per-permutation configs, de-dups, and filters by file', () => {
		// Five single-variant configs as an engine would dump them (different dump dirs).
		const mk = (file: string, entryPoint: string, stage: string, defines: object) =>
			parseShaderVariantConfig(JSON.stringify({ file, language: "hlsl", variants: [{ entryPoint, stage, defines }] }));
		const configs = [
			mk("D:/a/FXAAShader.usf", "FxaaPS", "fragment", { P: "0" }),
			mk("Z:/b/FXAAShader.usf", "FxaaPS", "fragment", { P: "1" }),
			mk("Q:/c/FXAAShader.usf", "FxaaPS", "fragment", { P: "0" }), // duplicate of #0 -> collapsed
			mk("W:/d/FXAAShader.usf", "FxaaVS", "vertex", {}),
			mk("D:/a/Other.usf", "MainCS", "compute", {}),             // different shader -> excluded
		];
		const entries = configs.map(c => ({ config: c, sourcePath: '/fake/config.json' }));
		let merged = mergeVariantConfigs(uri, entries, "FXAAShader.usf");
		assert.strictEqual(merged.length, 3);
		let sig = (name: string, stage: ShaderStage, defs: string) =>
			merged.some(v => v.name === name && v.stage.stage === stage && v.defines.defines.map(d => `${d.label}=${d.value}`).join(",") === defs);
		assert.ok(sig("FxaaPS", ShaderStage.fragment, "P=0"));
		assert.ok(sig("FxaaPS", ShaderStage.fragment, "P=1"));
		assert.ok(sig("FxaaVS", ShaderStage.vertex, ""));
		assert.ok(!merged.some(v => v.name === "MainCS"));
	});

	test('mergeVariantConfigsWithSignatures returns signatures aligned with variants', () => {
		const mk = (defines: object) =>
			parseShaderVariantConfig(JSON.stringify({ file: "FXAAShader.usf", variants: [{ entryPoint: "FxaaPS", stage: "fragment", defines }] }));
		const entries = [
			{ config: mk({ P: "0" }), sourcePath: '/fake/a.json' },
			{ config: mk({ P: "1" }), sourcePath: '/fake/b.json' },
			{ config: mk({ P: "0" }), sourcePath: '/fake/c.json' },
		];
		const merged = mergeVariantConfigsWithSignatures(uri, entries, "FXAAShader.usf");

		assert.strictEqual(merged.variants.length, 2);
		assert.strictEqual(merged.signatures.length, 2);
		assert.deepStrictEqual(merged.signatures, merged.variants.map(variantSignature));
		assert.deepStrictEqual(mergeVariantConfigs(uri, entries, "FXAAShader.usf").map(variantSignature), merged.signatures);
	});

	test('groupVariantsByEntryPoint groups by entry point, factors common defines, computes deltas', () => {
		let config = parseShaderVariantConfig(JSON.stringify({
			variants: [
				{ entryPoint: "FxaaPS", stage: "fragment", defines: { COMMON: "1", SM6: "1", P: "0" } },
				{ entryPoint: "FxaaPS", stage: "fragment", defines: { COMMON: "1", SM6: "1", P: "1" } },
				{ entryPoint: "FxaaVS", stage: "vertex", defines: { COMMON: "1", SM6: "1" } }
			]
		}));
		let groups = groupVariantsByEntryPoint(configToVariants(uri, config, "FXAAShader.usf"));
		assert.strictEqual(groups.length, 2);

		let ps = groups.find(g => g.name === "FxaaPS")!;
		assert.strictEqual(ps.stage, ShaderStage.fragment);
		assert.deepStrictEqual(ps.commonDefines.map(d => `${d.label}=${d.value}`).sort(), ["COMMON=1", "SM6=1"]);
		assert.strictEqual(ps.permutations.length, 2);
		assert.deepStrictEqual(
			ps.permutations.map(p => p.deltaDefines.map(d => `${d.label}=${d.value}`).join(",")).sort(),
			["P=0", "P=1"]
		);

		let vs = groups.find(g => g.name === "FxaaVS")!;
		assert.strictEqual(vs.stage, ShaderStage.vertex);
		assert.strictEqual(vs.permutations.length, 1);
		assert.strictEqual(vs.permutations[0].deltaDefines.length, 0); // single permutation -> all common
	});

	test('groupVariantsByEntryPoint separates same entry point with different stages', () => {
		let config = parseShaderVariantConfig(JSON.stringify({
			variants: [
				{ entryPoint: "Main", stage: "vertex" },
				{ entryPoint: "Main", stage: "fragment" }
			]
		}));
		let groups = groupVariantsByEntryPoint(configToVariants(uri, config, "FXAAShader.usf"));
		assert.strictEqual(groups.length, 2);
	});

	test('groupVariantsByEntryPoint exposes missing varying defines as undefined', () => {
		let config = parseShaderVariantConfig(JSON.stringify({
			variants: [
				{ entryPoint: "Main", stage: "compute", defines: { A: "1" } },
				{ entryPoint: "Main", stage: "compute", defines: { B: "2" } }
			]
		}));
		let groups = groupVariantsByEntryPoint(configToVariants(uri, config, "FXAAShader.usf"));
		assert.strictEqual(groups.length, 1);
		assert.deepStrictEqual(
			groups[0].permutations.map(p => p.deltaDefines.map(d => `${d.label}=${d.value}`).sort()),
			[["A=1", "B=_"], ["A=_", "B=2"]]
		);
	});

	test('configToVariants with sourcePath sets sourceConfigPaths on the variant only', () => {
		let config = parseShaderVariantConfig(JSON.stringify({
			file: "FXAAShader.usf",
			variants: [
				{ entryPoint: "FxaaPS", stage: "fragment", defines: { P: "0" } },
			]
		}));
		const sourcePath = '/D:/dumps/FXAAShader.json';
		let variants = configToVariants(uri, config, "FXAAShader.usf", sourcePath);
		assert.strictEqual(variants.length, 1);
		let variant = variants[0];
		assert.deepStrictEqual(variant.sourceConfigPaths, [sourcePath]);
		// Provenance lives on the variant; defines stay plain label/value pairs.
		for (let d of variant.defines.defines) {
			assert.ok(!('sourceConfigPaths' in d));
		}
		// Without a sourcePath the field is absent entirely (manual variants).
		let manual = configToVariants(uri, config, "FXAAShader.usf");
		assert.strictEqual(manual[0].sourceConfigPaths, undefined);
	});

	test('mergeVariantConfigsWithSignatures merges source paths on dedup', () => {
		const mk = (defines: object) =>
			parseShaderVariantConfig(JSON.stringify({ file: "FXAAShader.usf", variants: [{ entryPoint: "FxaaPS", stage: "fragment", defines }] }));
		const entries = [
			{ config: mk({ P: "0" }), sourcePath: '/dumps/FXAAShader_perm0.json' },
			{ config: mk({ P: "0" }), sourcePath: '/dumps/FXAAShader_perm0_dup.json' },
		];
		const merged = mergeVariantConfigsWithSignatures(uri, entries, "FXAAShader.usf");
		assert.strictEqual(merged.variants.length, 1);
		// Both source paths should be preserved.
		assert.deepStrictEqual(
			merged.variants[0].sourceConfigPaths,
			['/dumps/FXAAShader_perm0.json', '/dumps/FXAAShader_perm0_dup.json']
		);
	});

	test('formatPermutationValueSummary follows varying define order and omits names', () => {
		const defines = ["B", "A", "D"].map((label, index) => ({
			kind: "define" as const,
			label,
			value: String(index),
		}));
		assert.strictEqual(formatPermutationValueSummary(defines, ["A", "B", "C", "D"]), "1,0,_,2");
		assert.strictEqual(formatPermutationValueSummary(defines, ["D", "B"]), "2,0");
	});
});
