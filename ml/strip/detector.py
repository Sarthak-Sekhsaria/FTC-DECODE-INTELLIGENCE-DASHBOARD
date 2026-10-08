"""The RAMP strip detector: where along a RAMP's lane are ARTIFACTS, in one frame — and is this
strip a RAMP at all.

Input: one strip, 3 x 40 x 144 (RGB / 255), the lane straightened with the GATE end on the
left. Outputs:
- bins: 36 logits along the lane (bins of 4 px = a quarter of a slot), high where an ARTIFACT
  is centred. Fully convolutional along the lane, so an ARTIFACT rolling between two slots is
  found where it is, not only in the 9 resting places.
- ramp: one logit, high when the strip shows a RAMP lane (rails, the RAMP, queued ARTIFACTS),
  low when the lane landed beside it (floor, field wall, a GOAL panel, people). It is trained
  only with strips off the RAMP (train_detector.py --neg) and is not used for counting: on
  views it had not seen, it turned real RAMPS away. The shipped detector has the bins only
  (BinsOnly).
About 90k parameters: it runs on every frame of a video in the browser.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F


def block(cin, cout):
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
        nn.Conv2d(cout, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
    )


class StripDetector(nn.Module):
    def __init__(self, w=16):
        super().__init__()
        self.b1, self.b2, self.b3 = block(3, w), block(w, 2 * w), block(2 * w, 4 * w)
        self.head = nn.Sequential(nn.Conv1d(4 * w, 4 * w, 3, padding=1), nn.ReLU(inplace=True), nn.Conv1d(4 * w, 1, 1))
        self.ramp = nn.Sequential(nn.Linear(8 * w, 4 * w), nn.ReLU(inplace=True), nn.Linear(4 * w, 1))

    def maps(self, x):  # x: N x 3 x 40 x 144 in 0..1
        x = x - 0.5
        x = F.max_pool2d(self.b1(x), 2)  # 20 x 72
        x = F.max_pool2d(self.b2(x), 2)  # 10 x 36
        return self.b3(x)  # N x C x 10 x 36

    def both(self, x):
        m = self.maps(x)
        bins = self.head(m.amax(dim=2)).squeeze(1)  # N x 36: strongest response across the lane
        g = torch.cat([m.mean(dim=(2, 3)), m.amax(dim=(2, 3))], 1)  # N x 2C
        return bins, self.ramp(g).squeeze(1)

    def forward(self, x):
        return self.both(x)


class BinsOnly(nn.Module):
    """The detector without its RAMP output, for exporting one that was trained without it."""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        return self.net.both(x)[0]
