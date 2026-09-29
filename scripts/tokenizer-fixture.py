"""產生 test/fixtures/tokenizer-parity.json：HF BertTokenizerFast 對一組刁鑽字串的 token id 與字元位移。

位移換算成 JavaScript 的 UTF-16 索引，讓 src/tokenizer.ts 可以逐一比對。
用法：.venv/bin/python scripts/tokenizer-fixture.py
"""

import json
from pathlib import Path

from transformers import BertTokenizerFast

ROOT = Path(__file__).resolve().parent.parent
CASES = [
    "王小明於2023年3月5日在台中榮民總醫院就診。",
    "病人ID: AB-1234，Email〔EmailA〕，手機〔手機A〕。",
    "Dr. Smith visited Taipei on Monday, 10:30am.",
    "ÉCOLE naïve café résumé",
    "全形ＡＢＣ１２３與半形ABC123混用",
    "emoji 😀 與罕用字 𠮷 以及 ​ 零寬空白",
    "  多個   空白\t與\n換行  ",
    "unaffable antidisestablishmentarianism",
    "（括號）「引號」《書名》、頓號；分號！",
    "x" * 120,
    "",
]


def utf16_index(s: str, i: int) -> int:
    return len(s[:i].encode("utf-16-le")) // 2


def main() -> None:
    tok = BertTokenizerFast.from_pretrained("bert-base-chinese")
    out = []
    for s in CASES:
        e = tok(s, add_special_tokens=False, return_offsets_mapping=True)
        out.append({
            "text": s,
            "ids": e["input_ids"],
            "offsets": [[utf16_index(s, a), utf16_index(s, b)] for a, b in e["offset_mapping"]],
        })
    p = ROOT / "test" / "fixtures" / "tokenizer-parity.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(p, len(out))


if __name__ == "__main__":
    main()
