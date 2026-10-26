"""Export the image tower of a CLIP model (any Hugging Face `CLIPModel`) as a zero-shot ONNX
classifier for the extension. No training: the published weights are used as-is and the class
"names" are plain-language prompts (scripts/models/prompts.json) embedded by the text tower.

The graph takes raw canvas pixels and returns one probability per prompt group:

    input  "pixels": uint8 [1, H, W, 4]   RGBA from getImageData; H, W multiples of the patch size
    output "image":  float [1, 3]         whole-image prompts -> [female, male, none]
    output "face":   float [1, 2]         face-crop prompts   -> [female, male]

Preprocessing (RGBA->RGB, /255, mean/std, NHWC->NCHW), positional-embedding interpolation for
the input size, the projection and the prompt softmax are all inside the graph.

    python export_clip.py <hf model id or dir> <out.onnx> [--prompts prompts.json]
"""
import argparse
import json
import os

import torch
import torch.nn.functional as F
from transformers import CLIPModel, CLIPTokenizerFast

HERE = os.path.dirname(os.path.abspath(__file__))


class ZeroShot(torch.nn.Module):
    def __init__(self, clip, heads, mean, std):
        super().__init__()
        v = clip.vision_model
        self.patch_embedding = v.embeddings.patch_embedding
        self.class_embedding = v.embeddings.class_embedding
        pos = v.embeddings.position_embedding.weight.detach()  # [1 + g*g, D]
        self.register_buffer("pos_cls", pos[:1].clone())
        g = int(round((pos.shape[0] - 1) ** 0.5))
        self.register_buffer("pos_grid", pos[1:].reshape(1, g, g, -1).permute(0, 3, 1, 2).clone())
        self.pre_layrnorm = v.pre_layrnorm
        self.encoder = v.encoder
        self.post_layernorm = v.post_layernorm
        self.visual_projection = clip.visual_projection
        self.register_buffer("mean", torch.tensor(mean).view(1, 3, 1, 1) * 255.0)
        self.register_buffer("std", torch.tensor(std).view(1, 3, 1, 1) * 255.0)
        scale = clip.logit_scale.exp().detach()
        self.heads = list(heads)
        for name, (text_emb, group_index) in heads.items():
            self.register_buffer(f"text_{name}", (text_emb * scale).T.contiguous())  # [D, P]
            self.register_buffer(f"groups_{name}", group_index)  # [P, G] prompt -> group

    def forward(self, pixels):
        x = pixels[..., :3].permute(0, 3, 1, 2).float()
        x = (x - self.mean) / self.std
        b = x.shape[0]
        patches = self.patch_embedding(x)
        gh, gw = patches.shape[2], patches.shape[3]
        patches = patches.flatten(2).transpose(1, 2)
        grid = F.interpolate(self.pos_grid, size=(gh, gw), mode="bicubic", align_corners=False)
        grid = grid.flatten(2).transpose(1, 2)
        cls = (self.class_embedding + self.pos_cls).unsqueeze(0).expand(b, -1, -1)
        tokens = self.pre_layrnorm(torch.cat([cls, patches + grid], dim=1))
        hidden = self.encoder(inputs_embeds=tokens).last_hidden_state
        emb = self.visual_projection(self.post_layernorm(hidden[:, 0, :]))
        emb = emb / emb.norm(dim=-1, keepdim=True)
        outs = []
        for name in self.heads:
            probs = (emb @ getattr(self, f"text_{name}")).softmax(dim=-1)
            outs.append(probs @ getattr(self, f"groups_{name}"))
        return tuple(outs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("out")
    ap.add_argument("--prompts", default=os.path.join(HERE, "prompts.json"))
    ap.add_argument("--size", type=int, default=224, help="example input size used for tracing")
    a = ap.parse_args()

    clip = CLIPModel.from_pretrained(a.model, attn_implementation="eager").eval()
    try:
        tok = CLIPTokenizerFast.from_pretrained(a.model)
    except Exception:  # some checkpoints only ship tokenizer.json
        tok = CLIPTokenizerFast(tokenizer_file=os.path.join(a.model, "tokenizer.json"))
    pre = {}
    try:
        from transformers import CLIPImageProcessor
        ip = CLIPImageProcessor.from_pretrained(a.model)
        pre = {"mean": ip.image_mean, "std": ip.image_std}
    except Exception:
        pre = {"mean": [0.48145466, 0.4578275, 0.40821073], "std": [0.26862954, 0.26130258, 0.27577711]}

    prompts = json.load(open(a.prompts, encoding="utf-8"))
    heads = {}
    for head, spec in prompts.items():
        # {"mode": "sum"|"ensemble", "groups": {...}}; a bare {group: [prompts]} means "sum".
        groups = spec.get("groups", spec) if isinstance(spec, dict) else spec
        mode = spec.get("mode", "sum") if "groups" in spec else "sum"
        texts, owner = [], []
        for gi, (name, items) in enumerate(groups.items()):
            texts += items
            owner += [gi] * len(items)
        with torch.no_grad():
            te = clip.get_text_features(**tok(texts, padding=True, return_tensors="pt"))
            te = te / te.norm(dim=-1, keepdim=True)
        if mode == "ensemble":
            # Classic CLIP prompt ensembling: one averaged text embedding per group.
            owner_t = torch.tensor(owner)
            te = torch.stack([te[owner_t == gi].mean(0) for gi in range(len(groups))])
            te = te / te.norm(dim=-1, keepdim=True)
            gidx = torch.eye(len(groups))
        else:
            gidx = torch.zeros(len(texts), len(groups))
            gidx[torch.arange(len(texts)), torch.tensor(owner)] = 1.0
        heads[head] = (te, gidx)

    model = ZeroShot(clip, heads, pre["mean"], pre["std"]).eval()
    dummy = torch.zeros(1, a.size, a.size, 4, dtype=torch.uint8)
    with torch.no_grad():
        torch.onnx.export(model, (dummy,), a.out, input_names=["pixels"], output_names=list(prompts),
                          dynamic_axes={"pixels": {1: "height", 2: "width"}}, opset_version=17, dynamo=False)
    print("exported", a.out, "patch", clip.config.vision_config.patch_size,
          "outputs:", {k: list(v.get("groups", v)) for k, v in prompts.items()})


if __name__ == "__main__":
    main()
