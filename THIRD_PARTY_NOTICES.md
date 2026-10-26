# Third-party notices

NoHaram's own code is released under the [MIT License](LICENSE). The extension also ships the components below. Each one stays under its own license, and the full license texts are in [`licenses/`](licenses). The build copies this file and that folder into every packaged extension.

The models are used as published. NoHaram did not retrain or fine-tune any of them. The changes listed below only convert them to run in the browser.

| Component | Shipped as | License | License text |
|---|---|---|---|
| TinyCLIP ViT-8M/16 and ViT-39M/16, Microsoft | `models/tinyclip-8m-stage1.int8.onnx`, `models/tinyclip-39m-stage2.int8.onnx` | MIT, © Microsoft Corporation | [`licenses/TinyCLIP-MIT.txt`](licenses/TinyCLIP-MIT.txt) |
| YuNet face detector, 2023mar version, OpenCV Zoo | `models/yunet-2023mar.onnx` | MIT, © 2020 Shiqi Yu | [`licenses/YuNet-MIT.txt`](licenses/YuNet-MIT.txt) |
| age-gender-recognition-retail-0013, Intel Open Model Zoo | `models/openvino-agr0013-gender.int8.onnx` | Apache License 2.0, © Intel Corporation | [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt) |
| nsfw-image-detection-384, Marqo | `models/marqo-nsfw-384.onnx` | Apache License 2.0, © Marqo | [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt) |
| ONNX Runtime Web 1.30.0, Microsoft | bundled into `background.js`, `engine-worker.js` and `offscreen.js`, plus `ort-wasm-simd-threaded.wasm` | MIT, © Microsoft Corporation | [`licenses/ONNXRuntime-MIT.txt`](licenses/ONNXRuntime-MIT.txt), [`licenses/ONNXRuntime-ThirdPartyNotices.txt`](licenses/ONNXRuntime-ThirdPartyNotices.txt) |
| Lucide "settings" icon | the gear button in the popup | ISC, © 2026 Lucide Icons and Contributors | [`licenses/Lucide-ISC.txt`](licenses/Lucide-ISC.txt) |

## Sources and changes

**TinyCLIP**: [github.com/microsoft/Cream/tree/main/TinyCLIP](https://github.com/microsoft/Cream/tree/main/TinyCLIP). The weights come from Hugging Face: [`wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M`](https://huggingface.co/wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M) and [`wkcn/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M`](https://huggingface.co/wkcn/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M). Changes made by [`scripts/models/export_clip.py`](scripts/models/export_clip.py) and [`prepare_models.py`](scripts/models/prepare_models.py):
- Only the image encoder is exported, to ONNX.
- Input preprocessing is built into the graph.
- The text embeddings of the prompts in [`scripts/models/prompts-stage1.json`](scripts/models/prompts-stage1.json) and [`prompts-stage2.json`](scripts/models/prompts-stage2.json) are built into the graph.
- Matrix multiplications are quantized to 8 bits.

**YuNet**: [github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet). The input size was made dynamic, and the model takes RGBA pixels directly.

**age-gender-recognition-retail-0013**: [github.com/openvinotoolkit/open_model_zoo](https://github.com/openvinotoolkit/open_model_zoo/tree/master/models/intel/age-gender-recognition-retail-0013). Changes made by [`scripts/models/openvino_to_onnx.py`](scripts/models/openvino_to_onnx.py):
- Converted from OpenVINO IR to ONNX.
- Only the gender output is kept.
- The model takes RGBA pixels.
- Convolution weights are quantized to 8 bits.

**nsfw-image-detection-384**: [huggingface.co/Marqo/nsfw-image-detection-384](https://huggingface.co/Marqo/nsfw-image-detection-384). Marqo fine-tuned it from timm's `vit_tiny_patch16_384.augreg_in21k_ft_in1k` (Apache-2.0); NoHaram uses it as published. Changes made by [`scripts/models/export_nsfw.py`](scripts/models/export_nsfw.py):
- Exported to ONNX in full precision.
- The model takes RGBA pixels, with normalization built in.
- Only the NSFW probability is output.

**ONNX Runtime Web**: [github.com/microsoft/onnxruntime](https://github.com/microsoft/onnxruntime), used unmodified from the `onnxruntime-web` npm package. Its WebAssembly build contains third-party code; ONNX Runtime's own notices for it are in [`licenses/ONNXRuntime-ThirdPartyNotices.txt`](licenses/ONNXRuntime-ThirdPartyNotices.txt).

**Lucide**: [lucide.dev](https://lucide.dev), the `settings` icon, unmodified.
