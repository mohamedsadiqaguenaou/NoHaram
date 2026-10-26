"""Export Marqo/nsfw-image-detection-384 (Apache-2.0; a ViT-Tiny/16 NSFW classifier, used as
published) as an ONNX graph for the extension. It stays in full precision: 8-bit weights change
this model's verdicts noticeably.

    input  "pixels": uint8 [1, 384, 384, 4]   RGBA from getImageData (image squashed to 384x384)
    output "nsfw":   float [1]                probability that the image is NSFW

    python export_nsfw.py <out.onnx>
"""
import sys

import onnx
import onnxsim
import timm
import torch

REPO = "hf_hub:Marqo/nsfw-image-detection-384"


class NsfwProbability(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
        cfg = model.pretrained_cfg
        self.nsfw = cfg["label_names"].index("NSFW")
        self.register_buffer("mean", torch.tensor(cfg["mean"]).view(1, 3, 1, 1) * 255.0)
        self.register_buffer("std", torch.tensor(cfg["std"]).view(1, 3, 1, 1) * 255.0)

    def forward(self, pixels):
        x = pixels[..., :3].permute(0, 3, 1, 2).float()
        x = (x - self.mean) / self.std
        return self.model(x).softmax(dim=-1)[:, self.nsfw]


def main():
    out = sys.argv[1]
    model = timm.create_model(REPO, pretrained=True).eval().requires_grad_(False)
    size = model.pretrained_cfg["input_size"][1]
    wrapped = NsfwProbability(model).eval()
    with torch.no_grad():
        torch.onnx.export(wrapped, (torch.zeros(1, size, size, 4, dtype=torch.uint8),), out, input_names=["pixels"],
                          output_names=["nsfw"], opset_version=17, dynamo=False)
    simplified, ok = onnxsim.simplify(onnx.load(out))
    if not ok:
        raise SystemExit("onnxsim failed")
    onnx.save(simplified, out)
    print("exported", out, "input", size)


if __name__ == "__main__":
    main()
