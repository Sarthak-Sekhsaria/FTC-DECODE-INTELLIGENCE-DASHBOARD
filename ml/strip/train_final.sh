#!/bin/bash
# The models the app ships (public/models/ramp-*.onnx), trained on every training video.
#   ml/strip/train_final.sh <work dir with q_oof from cross_fit.py> <dir with sbAll_<key>.json> <out dir>
# The work dir's lane responses come first, for the originals and the 360p / 240p renditions, each
# video's from a fold detector that never saw it (as the app's detector sees a user's video). The
# fold detectors are trained on the renditions and on strips off the RAMP:
#   python cross_fit.py --data <strips15> --bar <dir> --work <work dir> --variants _360p,_240p --neg <strips_neg> --no_entry
# The strip detector is trained on all training RAMPS at the original resolution only. Low
# resolution is covered by its augmentation. Training it on the renditions or on strips off the
# RAMP made it quieter on unfamiliar views. The entry counter is trained on the cross-fitted
# responses of every rendition, three seeds averaged. Fold detectors at the original resolution
# only (--det_variants "") made it amplify weak responses: it overcounted held-out videos, 27.6 %
# against 17.8 % (docs/auto-ramp-counting-v2.md).
set -e
cd "$(dirname "$0")"
WORK="$1"; BAR="$2"; OUT="$3"
PY="$LOCALAPPDATA/ArtifactIQ/train-venv/Scripts/python.exe"
DATA="$LOCALAPPDATA/ArtifactIQ/data/strips15"
GOOD="T01:b,T02:r,T02:b,T03:r,T03:b,T04:r,T05:r,T13:r,T13:b,T14:r,T14:b,T15:b,T17:r,T17:b,T23:r,T23:b,T26:r,T26:b,T27:r,T27:b,T28:r,T28:b,T29:r,T29:b"
BARR="T03:r,T03:b,T04:r,T05:r,T13:r,T13:b,T14:r,T14:b,T17:r,T17:b,T23:r,T23:b,T26:r,T26:b,T27:r,T27:b,T28:r,T28:b"
expand() { echo "$1" | tr ',' '\n' | while read r; do k=${r%%:*}; s=${r##*:}; echo "$k:$s,${k}_360p:$s,${k}_240p:$s"; done | tr '\n' ',' | sed 's/,$//'; }
R=$(expand "$BARR")
K=$(echo "$GOOD" | tr ',' '\n' | cut -d: -f1 | sort -u | tr '\n' ',' | sed 's/,$//')
mkdir -p "$OUT"
if [ ! -f "$OUT/detector.pt" ]; then
  "$PY" -u train_detector.py --data "$DATA" --train "$K" --ramps "$GOOD" --epochs 14 --every 2 --out "$OUT/detector.onnx"
fi
for seed in 1 2 3; do
  "$PY" -u train_entry_real.py --q "$WORK/q_oof" --bar "$BAR" --ramps "$R" --zero_ramps "T16:r,T16:b,T20:r,T20:b" --init "$LOCALAPPDATA/ArtifactIQ/models/entry_bn_sim.pt" --steps 3000 --seed $seed --out "$OUT/entry_s$seed.pt" &
done
wait
"$PY" export_entry_ensemble.py "$OUT/entries.onnx" "$OUT/entry_s1.pt" "$OUT/entry_s2.pt" "$OUT/entry_s3.pt"
"$PY" check_onnx.py "$OUT/detector.pt" "$OUT/detector_check.onnx"
