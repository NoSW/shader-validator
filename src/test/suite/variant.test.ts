import * as assert from 'assert';

import * as vscode from 'vscode';
import {
	parseShaderVariantConfig,
	configToVariants,
	variantSignature,
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
});
