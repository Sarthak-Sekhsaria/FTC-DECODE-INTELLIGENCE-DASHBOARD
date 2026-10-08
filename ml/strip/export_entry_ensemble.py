"""Average several entry counters (trained with different seeds) into one ONNX model for the app.

  python export_entry_ensemble.py out.onnx entry_s1.pt entry_s2.pt entry_s3.pt
"""

import sys

import numpy as np
import onnxruntime as ort
import torch
import torch.nn as nn

from entry_model import EntryNet


class Ensemble(nn.Module):
    def __init__(self, nets):
        super().__init__()
        self.nets = nn.ModuleList(nets)

    def forward(self, x):
        return torch.stack([n(x) for n in self.nets]).mean(0)


def main():
    out, paths = sys.argv[1], sys.argv[2:]
    nets = []
    for p in paths:
        n = EntryNet()
        n.load_state_dict(torch.load(p, map_location="cpu"))
        nets.append(n.eval())
    ens = Ensemble(nets).eval()
    torch.onnx.export(ens, torch.zeros(1, 2, 150, 36), out, input_names=["q"], output_names=["entries"], dynamic_axes={"q": {0: "n", 2: "t"}, "entries": {0: "n", 1: "t"}}, opset_version=17, dynamo=False)
    s = ort.InferenceSession(out)
    x = np.random.rand(1, 2, 400, 36).astype(np.float32)
    ref = ens(torch.from_numpy(x)).detach().numpy()
    print(f"{out}: {len(nets)} counters averaged; max abs diff vs torch {float(np.abs(s.run(None, {'q': x})[0] - ref).max()):.2e}")


if __name__ == "__main__":
    main()
