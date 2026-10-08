"""The entry counter: how many ARTIFACTS came onto a RAMP, frame by frame.

Input: the strip detector's output over time for one RAMP, N x 2 x T x 36: channel 0 the
probability per bin along the lane (bin 0 at the GATE end, 35 at the top), channel 1 whether the
RAMP was seen in that frame (1) or not (0: untracked, outside the picture, or a frame skipped).
Output: N x T, the expected number of ARTIFACTS that came onto the RAMP at each frame (>= 0).
The count over any stretch of the match is the sum over its frames.

An ARTIFACT coming on shows as a response appearing at the top of the visible lane and moving
down it (to the GATE, or onto the queue), or appearing and staying (the 9th). A queue released
through the GATE moves down too, but starts lower and was there before. The network sees ~1.2 s
either side of a frame to tell these apart.
"""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


def conv(cin, cout, k, pad, dil=1):
    # BatchNorm, not a norm over the input: with its fixed statistics at inference a frame's
    # count depends only on the frames within reach, so a match can be counted piece by piece
    # (live) and gives the same as counted whole.
    return nn.Sequential(nn.Conv2d(cin, cout, k, padding=pad, dilation=dil, bias=False), nn.BatchNorm2d(cout), nn.LeakyReLU(0.1, inplace=True))


class EntryNet(nn.Module):
    def __init__(self, c=32, prior=0.02):
        super().__init__()
        self.f = nn.Sequential(
            conv(2, 16, 5, 2),
            conv(16, c, 5, 2),
            conv(c, c, 5, (4, 2), (2, 1)),
            conv(c, c, 5, (8, 2), (4, 1)),
        )
        self.across = nn.Sequential(nn.Conv2d(c, 2 * c, (1, 36)), nn.LeakyReLU(0.1, inplace=True))  # the whole lane at once
        self.t1 = nn.Sequential(nn.Conv1d(2 * c, 2 * c, 5, padding=2), nn.LeakyReLU(0.1, inplace=True))
        self.out = nn.Conv1d(2 * c, 1, 1)
        # start near a typical rate of entries per frame
        nn.init.constant_(self.out.bias, math.log(math.expm1(prior)))

    def forward(self, x):  # N x 2 x T x 36
        x = self.f(x)
        x = self.across(x).squeeze(3)  # N x 2c x T
        x = self.t1(x)
        return F.softplus(self.out(x).squeeze(1))  # N x T
