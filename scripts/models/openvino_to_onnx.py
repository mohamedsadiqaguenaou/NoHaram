"""Translate a simple OpenVINO IR (v10/v11) CNN into ONNX — no retraining, weights are copied as-is.

Supports the op subset used by Intel's age-gender-recognition-retail-0013:
Parameter, Const, Convolution, Add (bias), ReLU, MaxPool, SoftMax, Result.

    python openvino_to_onnx.py model.xml model.bin out.onnx --outputs prob --rename prob=gender
"""
import argparse
import xml.etree.ElementTree as ET

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

DTYPES = {"f32": np.float32, "f16": np.float16, "i64": np.int64, "i32": np.int32}


def ints(s):
    return [int(v) for v in s.replace(" ", "").split(",") if v != ""]


def convert(xml_path, bin_path, out_path, keep_outputs, renames):
    root = ET.parse(xml_path).getroot()
    blob = open(bin_path, "rb").read()
    layers = {l.get("id"): l for l in root.find("layers")}
    # (to_layer, to_port) -> (from_layer, from_port)
    edges = {(e.get("to-layer"), e.get("to-port")): (e.get("from-layer"), e.get("from-port"))
             for e in root.find("edges")}

    def inputs_of(lid):
        ports = sorted((int(tp), fl) for (tl, tp), (fl, fp) in edges.items() if tl == lid)
        return [fl for _, fl in ports]

    consts, names, nodes, inits, graph_inputs, graph_outputs = {}, {}, [], [], [], []

    def const_array(lid):
        d = layers[lid].find("data").attrib
        arr = np.frombuffer(blob, dtype=DTYPES[d["element_type"]], count=int(d["size"]) // np.dtype(
            DTYPES[d["element_type"]]).itemsize, offset=int(d["offset"]))
        return arr.reshape(ints(d["shape"])).astype(np.float32)

    # Walk layers in topological order (ids in IR are topologically sorted for these models,
    # but sort by dependency to be safe).
    order, seen = [], set()

    def visit(lid):
        if lid in seen:
            return
        seen.add(lid)
        for src in inputs_of(lid):
            visit(src)
        order.append(lid)

    for lid in layers:
        visit(lid)

    folded_bias = set()
    for lid in order:
        l = layers[lid]
        typ, name = l.get("type"), l.get("name")
        data = l.find("data")
        attrs = data.attrib if data is not None else {}
        ins = inputs_of(lid)
        out_name = f"t{lid}"
        if typ == "Const":
            consts[lid] = const_array(lid)
            continue
        if typ == "Parameter":
            shape = ints(attrs["shape"])
            graph_inputs.append(helper.make_tensor_value_info("input", TensorProto.FLOAT, shape))
            names[lid] = "input"
            continue
        if typ == "Convolution":
            x, w = ins
            wname = f"w{lid}"
            inits.append(numpy_helper.from_array(consts[w], wname))
            conv_inputs = [names[x], wname]
            # Fold a following `Add(const [1,C,1,1])` into the conv bias.
            consumer = [tl for (tl, tp), (fl, fp) in edges.items() if fl == lid]
            if len(consumer) == 1 and layers[consumer[0]].get("type") == "Add":
                add_id = consumer[0]
                other = [s for s in inputs_of(add_id) if s != lid][0]
                if other in consts:
                    bname = f"b{lid}"
                    inits.append(numpy_helper.from_array(consts[other].reshape(-1), bname))
                    conv_inputs.append(bname)
                    folded_bias.add(add_id)
                    out_name = f"t{add_id}"
                    names[add_id] = out_name
            pb, pe = ints(attrs["pads_begin"]), ints(attrs["pads_end"])
            nodes.append(helper.make_node("Conv", conv_inputs, [out_name], name=name,
                                          strides=ints(attrs["strides"]), dilations=ints(attrs["dilations"]),
                                          pads=pb + pe, kernel_shape=list(consts[w].shape[2:])))
            names[lid] = out_name
            continue
        if typ == "Add":
            if lid in folded_bias:
                continue
            a, b = ins
            for side in (a, b):
                if side in consts and side not in names:
                    cname = f"c{side}"
                    inits.append(numpy_helper.from_array(consts[side], cname))
                    names[side] = cname
            nodes.append(helper.make_node("Add", [names[a], names[b]], [out_name], name=name))
        elif typ == "ReLU":
            nodes.append(helper.make_node("Relu", [names[ins[0]]], [out_name], name=name))
        elif typ == "MaxPool":
            pb, pe = ints(attrs["pads_begin"]), ints(attrs["pads_end"])
            nodes.append(helper.make_node("MaxPool", [names[ins[0]]], [out_name], name=name,
                                          kernel_shape=ints(attrs["kernel"]), strides=ints(attrs["strides"]),
                                          pads=pb + pe, ceil_mode=1 if attrs.get("rounding_type") == "ceil" else 0))
        elif typ == "SoftMax":
            nodes.append(helper.make_node("Softmax", [names[ins[0]]], [out_name], name=name,
                                          axis=int(attrs.get("axis", 1))))
        elif typ == "Result":
            src = ins[0]
            src_name = layers[src].get("name")
            if keep_outputs and src_name not in keep_outputs:
                continue
            final = renames.get(src_name, src_name)
            nodes.append(helper.make_node("Identity", [names[src]], [final], name=f"out_{final}"))
            dims = [int(d.text) for d in layers[src].find("output/port").findall("dim")]
            graph_outputs.append(helper.make_tensor_value_info(final, TensorProto.FLOAT, dims))
            continue
        else:
            raise NotImplementedError(f"layer type {typ} ({name})")
        names[lid] = out_name

    # Drop everything that does not feed a kept output (e.g. the age head).
    needed = {o.name for o in graph_outputs}
    kept = []
    for n in reversed(nodes):
        if any(o in needed for o in n.output):
            kept.append(n)
            needed.update(n.input)
    kept.reverse()
    inits = [i for i in inits if i.name in needed]

    graph = helper.make_graph(kept, "converted", graph_inputs, graph_outputs, inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="noharam-openvino2onnx")
    model.ir_version = 8
    onnx.checker.check_model(model)
    model = onnx.shape_inference.infer_shapes(model)
    onnx.save(model, out_path)
    print(f"wrote {out_path}: {len(kept)} nodes, {sum(i.raw_data.__len__() for i in inits) / 1e6:.2f} MB weights")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xml")
    ap.add_argument("bin")
    ap.add_argument("out")
    ap.add_argument("--outputs", nargs="*", default=[], help="IR layer names of outputs to keep")
    ap.add_argument("--rename", nargs="*", default=[], help="old=new output renames")
    a = ap.parse_args()
    convert(a.xml, a.bin, a.out, set(a.outputs), dict(r.split("=", 1) for r in a.rename))


if __name__ == "__main__":
    main()
