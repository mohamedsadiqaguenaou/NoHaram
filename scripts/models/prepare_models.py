"""Download the existing pre-trained models, convert them for the extension and write src/models/.

No training happens here: every model is used exactly as published, only converted / quantized.

  * TinyCLIP-ViT-8M-16-Text-3M-YFCC15M (Microsoft, MIT)   -> stage 1: "is anybody in this picture?" (fast)
  * TinyCLIP-ViT-39M-16-Text-19M-YFCC15M (Microsoft, MIT) -> stage 2: women / men, whole image + face crops
  * YuNet face detector 2023mar (OpenCV Zoo, MIT)          -> face boxes
  * age-gender-recognition-retail-0013 (Intel OMZ, Apache-2) -> face-crop gender (2nd opinion)
  * nsfw-image-detection-384 (Marqo, Apache-2, ViT-Tiny)   -> nudity / explicit images (full precision)

Every exported graph takes raw canvas pixels: uint8 [1, H, W, 4] (RGBA from getImageData).

    pip install torch transformers timm onnx onnxruntime onnxsim
    python scripts/models/prepare_models.py [--cache DIR]
"""
import argparse
import os
import subprocess
import sys
import urllib.request

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "src", "models")

CLIP_MODELS = {
    # out file: (Hugging Face repo, prompt file)
    "tinyclip-8m-stage1.int8.onnx": ("wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M", "prompts-stage1.json"),
    "tinyclip-39m-stage2.int8.onnx": ("wkcn/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M", "prompts-stage2.json"),
}
HF_FILES = ["config.json", "model.safetensors", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
            "vocab.json", "merges.txt", "special_tokens_map.json"]
YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
OMZ = ("https://storage.openvinotoolkit.org/repositories/open_model_zoo/2022.1/models_bin/2/"
       "age-gender-recognition-retail-0013/FP32/age-gender-recognition-retail-0013")

YUNET_OUT = "yunet-2023mar.onnx"
NSFW_OUT = "marqo-nsfw-384.onnx"
GENDER_OUT = "openvino-agr0013-gender.int8.onnx"


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "noharam-model-prep"})
    with urllib.request.urlopen(req, timeout=120) as r, open(path + ".part", "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(path + ".part", path)
    return path


def rgba_input(model, old_input, bgr, scale=1.0):
    """Prepend uint8 RGBA NHWC -> float NCHW (optionally BGR, scaled) conversion to a graph."""
    g = model.graph
    old = next(i for i in g.input if i.name == old_input)
    g.input.remove(old)
    g.input.insert(0, helper.make_tensor_value_info("pixels", TensorProto.UINT8, [1, "height", "width", 4]))
    order = [2, 1, 0] if bgr else [0, 1, 2]
    g.initializer.extend([numpy_helper.from_array(np.array(order, np.int64), "nh_rgb_order")])
    nodes = [
        helper.make_node("Cast", ["pixels"], ["nh_f"], to=TensorProto.FLOAT),
        helper.make_node("Gather", ["nh_f", "nh_rgb_order"], ["nh_rgb"], axis=3),
        helper.make_node("Transpose", ["nh_rgb"], [old_input if scale == 1.0 else "nh_nchw"], perm=[0, 3, 1, 2]),
    ]
    if scale != 1.0:
        g.initializer.extend([numpy_helper.from_array(np.array(scale, np.float32), "nh_scale")])
        nodes.append(helper.make_node("Mul", ["nh_nchw", "nh_scale"], [old_input]))
    for i, n in enumerate(nodes):
        g.node.insert(i, n)
    return model


def make_dynamic(model):
    del model.graph.value_info[:]
    for o in model.graph.output:
        for i, d in enumerate(o.type.tensor_type.shape.dim):
            if i > 0 and d.HasField("dim_value"):
                d.ClearField("dim_value")
                d.dim_param = f"{o.name}_d{i}"
    return model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(ROOT, ".model-cache"), help="where downloads are kept")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    from onnxruntime.quantization import QuantType, quantize_dynamic
    import onnxsim

    # 1) TinyCLIP models -> zero-shot ONNX (preprocessing + prompts baked in) -> INT8 (MatMul/Gemm)
    for out_name, (repo, prompt_file) in CLIP_MODELS.items():
        model_dir = os.path.join(a.cache, repo.split("/")[-1])
        for f in HF_FILES:
            try:
                fetch(f"https://huggingface.co/{repo}/resolve/main/{f}", os.path.join(model_dir, f))
            except Exception:
                pass  # optional tokenizer files
        fp32 = os.path.join(a.cache, out_name.replace(".int8.onnx", ".fp32.onnx"))
        subprocess.check_call([sys.executable, os.path.join(HERE, "export_clip.py"), model_dir, fp32,
                               "--prompts", os.path.join(HERE, prompt_file)])
        sim, ok = onnxsim.simplify(onnx.load(fp32))
        assert ok, f"onnxsim failed on {repo}"
        sim_path = fp32.replace(".fp32.onnx", ".sim.onnx")
        onnx.save(sim, sim_path)
        # Keep the tiny prompt head (emb @ text, probs @ groups) in fp32: quantizing it skews probabilities.
        inits = {i.name for i in sim.graph.initializer}
        head = [n.name for n in sim.graph.node if n.op_type == "MatMul"
                and any(x in inits and (x.startswith("text_") or x.startswith("groups_")) for x in n.input)]
        quantize_dynamic(sim_path, os.path.join(OUT, out_name), weight_type=QuantType.QUInt8,
                         op_types_to_quantize=["MatMul", "Gemm"], nodes_to_exclude=head)

    # 2) YuNet: dynamic H/W + RGBA uint8 input (model wants BGR 0..255)
    yunet = onnx.load(fetch(YUNET_URL, os.path.join(a.cache, "face_detection_yunet_2023mar.onnx")))
    yunet = make_dynamic(yunet)
    for d in yunet.graph.input[0].type.tensor_type.shape.dim[2:]:
        d.ClearField("dim_value")
    yunet = rgba_input(yunet, "input", bgr=True)
    onnx.checker.check_model(yunet)
    onnx.save(yunet, os.path.join(OUT, YUNET_OUT))

    # 3) OpenVINO age-gender-recognition-retail-0013 -> ONNX (gender head only), RGBA input, INT8 convs
    xml = fetch(OMZ + ".xml", os.path.join(a.cache, "agr0013.xml"))
    bin_ = fetch(OMZ + ".bin", os.path.join(a.cache, "agr0013.bin"))
    gender_fp32 = os.path.join(a.cache, "agr0013-gender.onnx")
    subprocess.check_call([sys.executable, os.path.join(HERE, "openvino_to_onnx.py"), xml, bin_, gender_fp32,
                           "--outputs", "prob", "--rename", "prob=gender"])
    g = rgba_input(onnx.load(gender_fp32), "input", bgr=True)
    for d in g.graph.input[0].type.tensor_type.shape.dim[1:3]:
        d.ClearField("dim_param")
        d.dim_value = 62
    g_rgba = os.path.join(a.cache, "agr0013-gender-rgba.onnx")
    onnx.save(g, g_rgba)
    quantize_dynamic(g_rgba, os.path.join(OUT, GENDER_OUT), weight_type=QuantType.QUInt8, op_types_to_quantize=["Conv"])

    # 4) Marqo NSFW detector -> ONNX with RGBA input, kept in full precision
    subprocess.check_call([sys.executable, os.path.join(HERE, "export_nsfw.py"), os.path.join(OUT, NSFW_OUT)])

    for f in (*CLIP_MODELS, YUNET_OUT, GENDER_OUT, NSFW_OUT):
        p = os.path.join(OUT, f)
        print(f"{f:40s} {os.path.getsize(p) / 1e6:6.2f} MB")


if __name__ == "__main__":
    main()
