"""可选离线 FLIP 校准；依赖 flip-evaluator==1.7、Pillow、numpy，不进入产品运行时。"""
import argparse
import hashlib
import importlib.metadata
import json
import math
import platform
import re
import sys
import time
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image, __version__ as pillow_version

parser = argparse.ArgumentParser()
parser.add_argument("--from", dest="source", type=Path, required=True)
parser.add_argument("--out", dest="target", type=Path, required=True)
args = parser.parse_args()
args.target.mkdir()  # 保留已有试验
report = json.loads((args.source / "report.json").read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rgb(path, size=None):
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
        image = Image.alpha_composite(Image.new("RGBA", rgba.size, "white"), rgba).convert("RGB")
        if size and image.size != size:
            image = image.resize(size, Image.Resampling.LANCZOS)
        return np.ascontiguousarray(np.asarray(image, dtype=np.float32) / 255.0)


regions = {"header": (0, 0, 1, 165 / 780), "stations": (0, 165 / 780, 1, 630 / 780),
           "roads": (0, 630 / 780, 1, 680 / 780), "next-stop": (0, 680 / 780, 950 / 3496, 1),
           "service": (950 / 3496, 680 / 780, 1, 1)}
affected = {"missing-station": "stations", "reverse-stations": "stations", "missing-times": "service",
            "small-stations": "stations", "shift-stations": "stations", "missing-landmarks": "stations", "extra-label": "stations"}
results = []
for row in report["rows"]:
    # 合法输入变化不能作为还原退步；FLIP 校准只用固定数据的坏例及历史观察集。
    if row["origin"] == "counterfactual-input":
        continue
    if not re.fullmatch(r"[a-z0-9-]+", row["id"]):
        raise ValueError("非法报告 ID")
    image_path = args.source / row["id"] / "actual.png"
    if not image_path.exists():
        results.append({"id": row["id"], "status": "no-clean-image"})
        continue
    if row["imageKind"] != "clean-final" or digest(image_path) != row["imageSha256"]:
        raise ValueError("候选不是报告绑定的干净图像")
    if digest(args.source / "reference.jpg") != row["sampleSha256"]:
        raise ValueError("参考图与报告不一致")
    actual = rgb(image_path)
    height, width = actual.shape[:2]
    for reference_id, reference_path in [("sample", args.source / "reference.jpg"), ("control", args.source / "control" / "actual.png")]:
        reference = rgb(reference_path, (width, height))
        started = time.perf_counter()
        error_map, mean_error, parameters = flip_evaluator.evaluate(reference, actual, "LDR", inputsRGB=True,
            applyMagma=False, parameters={"ppd": 67})
        elapsed_ms = (time.perf_counter() - started) * 1000
        errors = np.asarray(error_map).squeeze()
        if errors.shape != (height, width):
            raise ValueError("FLIP error map shape mismatch")
        region_means = {name: float(np.mean(errors[int(y0 * height):int(np.ceil(y1 * height)),
                                             int(x0 * width):int(np.ceil(x1 * width))]))
                        for name, (x0, y0, x1, y1) in regions.items()}
        magma, _, _ = flip_evaluator.evaluate(reference, actual, "LDR", inputsRGB=True,
            applyMagma=True, computeMeanError=False, parameters={"ppd": 67})
        heatmap_name = f"{row['id']}-{reference_id}-flip.png"
        Image.fromarray(np.rint(np.clip(magma, 0, 1) * 255).astype(np.uint8)).save(args.target / heatmap_name)
        result = {"id": row["id"], "reference": reference_id, "meanError": float(mean_error), "regionMeans": region_means,
                  "highestRegion": max(region_means, key=region_means.get), "expectedAffectedRegion": affected.get(row["id"]),
                  "elapsedMs": elapsed_ms, "parameters": {k: (v if not isinstance(v, float) or math.isfinite(v) else None) for k, v in parameters.items()}, "size": [width, height], "heatmap": heatmap_name,
                  "referenceSha256": digest(reference_path), "actualSha256": digest(image_path)}
        results.append(result)
        print(json.dumps({k: result[k] for k in ["id", "reference", "meanError", "highestRegion"]}))

calibration = [r for r in results if r.get("reference") == "control" and r.get("expectedAffectedRegion")]
checks = [{"name": "正例与自身误差为零", "pass": next(r for r in results if r["id"] == "control" and r.get("reference") == "control")["meanError"] < 1e-6},
          *[{"name": r["id"] + " 最大均值位于已知修改区域", "pass": r["highestRegion"] == r["expectedAffectedRegion"]} for r in calibration]]
output = {"format": "renderweave-fidelity-flip/1", "sourceReportSha256": digest(args.source / "report.json"),
          "scriptSha256": digest(Path(__file__)), "versions": {"python": platform.python_version(), "flip": importlib.metadata.version("flip-evaluator"), "pillow": pillow_version, "numpy": np.__version__},
          "normalization": "白底 alpha 合成；参考图 LANCZOS 缩至候选尺寸；sRGB LDR；67 PPD；不局部配准",
          "parameterNote": "LDR 未使用的 HDR 曝光参数可能为无穷；JSON 中保存为 null。",
          "scope": "局部外观定位校准。全图/区域均值都不能替代内容核查；未验证 Agent 修复率与人类偏好。",
          "regions": regions, "checks": checks, "rows": results}
(args.target / "report.json").write_text(json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
print(json.dumps({"checksPassed": sum(c["pass"] for c in checks), "checks": len(checks)}))
sys.exit(0 if all(c["pass"] for c in checks) else 1)
