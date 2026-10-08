"""Export check: the ONNX model the app runs gives the same numbers as the PyTorch one.

  python check_onnx.py model.pt model.onnx

A detector trained without strips off the RAMP has no RAMP output; it is exported with the
ARTIFACT bins only (the app then takes every followed frame as seen).
"""

import sys

import numpy as np
import onnxruntime as ort
import torch

from detector import BinsOnly, StripDetector

net = StripDetector().eval()
has_ramp = True
if sys.argv[1] != "-":
    sd = torch.load(sys.argv[1], map_location="cpu")
    has_ramp = any(k.startswith("ramp.") for k in sd)
    net.load_state_dict(sd, strict=has_ramp)
out = sys.argv[2]
x0 = torch.zeros(1, 3, 40, 144)
if has_ramp:
    torch.onnx.export(net, x0, out, input_names=["strip"], output_names=["bins", "ramp"], dynamic_axes={"strip": {0: "n"}, "bins": {0: "n"}, "ramp": {0: "n"}}, opset_version=17, dynamo=False)
else:
    torch.onnx.export(BinsOnly(net).eval(), x0, out, input_names=["strip"], output_names=["bins"], dynamic_axes={"strip": {0: "n"}, "bins": {0: "n"}}, opset_version=17, dynamo=False)
s = ort.InferenceSession(out)
x = np.random.rand(4, 3, 40, 144).astype(np.float32)
res = s.run(None, {"strip": x})
with torch.no_grad():
    rb, rr = net(torch.from_numpy(x))
diffs = [float(np.abs(res[0] - rb.numpy()).max())] + ([float(np.abs(res[1] - rr.numpy()).max())] if has_ramp else [])
print("onnx outputs", [o.name for o in s.get_outputs()], "max abs diff vs torch", diffs)
