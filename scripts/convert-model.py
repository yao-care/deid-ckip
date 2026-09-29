"""下載 CKIP NER 模型 → ONNX（service.yaml 的 model.quantize 為 int8 時再做動態量化）→ models/。

2026-09-29 實測 albert-tiny-chinese-ner 的 int8 量化只有 88.5% 標籤與 fp32 一致，
因此預設 quantize: none（fp32，約 16 MB）。

用法（在 repo 根目錄）：
    uv venv --python 3.12 .venv
    uv pip install --python .venv/bin/python -r scripts/requirements.txt
    .venv/bin/python scripts/convert-model.py

產物：models/model.onnx、models/vocab.txt、models/config.json、models/manifest.json（sha256）。
同一份 sha256 會寫到 model-manifest.json（進版控），建置時核對。
"""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
import yaml
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForTokenClassification, BertTokenizerFast

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "models"

# 轉換後自我檢查用的虛構句子（不含真實個資）
CHECK = [
    "王小明於2023年3月5日在台中榮民總醫院就診，由林醫師看診。",
    "陳美華住在高雄市苓雅區，上週到長庚醫院復健科回診。",
    "張志偉是台灣大學的教授，早上九點在台北車站見到李宗翰。",
]


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> None:
    svc = yaml.safe_load((ROOT / "service.yaml").read_text(encoding="utf-8"))
    source, tok_name = svc["model"]["source"], svc["model"]["tokenizer"]
    OUT.mkdir(exist_ok=True)

    model = AutoModelForTokenClassification.from_pretrained(source).eval()
    tok = BertTokenizerFast.from_pretrained(tok_name)

    fp32 = OUT / "model.fp32.onnx"
    dummy = tok(CHECK[0], return_tensors="pt")
    torch.onnx.export(
        model,
        (dummy["input_ids"], dummy["attention_mask"], dummy["token_type_ids"]),
        str(fp32),
        input_names=["input_ids", "attention_mask", "token_type_ids"],
        output_names=["logits"],
        dynamic_axes={n: {0: "batch", 1: "seq"} for n in ["input_ids", "attention_mask", "token_type_ids", "logits"]},
        opset_version=14,
    )
    onnx_path = OUT / "model.onnx"
    if svc["model"]["quantize"] == "int8":
        quantize_dynamic(str(fp32), str(onnx_path), weight_type=QuantType.QInt8)
        fp32.unlink()
    else:
        fp32.replace(onnx_path)

    # 與 PyTorch 比對：逐 token 的標籤一致率
    sess = ort.InferenceSession(str(onnx_path))
    same = total = 0
    for s in CHECK:
        e = tok(s, return_tensors="np")
        feeds = {k: e[k].astype(np.int64) for k in ["input_ids", "attention_mask", "token_type_ids"]}
        q = sess.run(["logits"], feeds)[0][0].argmax(-1)
        with torch.no_grad():
            ref = model(**{k: torch.from_numpy(v) for k, v in feeds.items()}).logits[0].argmax(-1).numpy()
        same += int((q == ref).sum())
        total += len(ref)
    agreement = same / total
    print(f"ONNX 與 PyTorch 標籤一致率：{agreement:.4f}（{same}/{total}）")
    if agreement < 0.97:
        sys.exit("一致率低於 0.97，品質不足；若有量化請改 quantize: none")

    (OUT / "vocab.txt").write_text("\n".join(tok.convert_ids_to_tokens(list(range(tok.vocab_size)))) + "\n", encoding="utf-8")
    cfg = {
        "source": source,
        "tokenizer": tok_name,
        "do_lower_case": bool(tok.do_lower_case),
        "max_len": int(model.config.max_position_embeddings),
        "id2label": {str(k): v for k, v in model.config.id2label.items()},
    }
    (OUT / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    files = {f: sha256(OUT / f) for f in ["model.onnx", "vocab.txt", "config.json"]}
    manifest = json.dumps({"source": source, "tokenizer": tok_name, "files": files}, indent=2) + "\n"
    (OUT / "manifest.json").write_text(manifest, encoding="utf-8")
    (ROOT / "model-manifest.json").write_text(manifest, encoding="utf-8")
    for f, h in files.items():
        print(f"{f}\t{(OUT / f).stat().st_size}\t{h}")


if __name__ == "__main__":
    main()
