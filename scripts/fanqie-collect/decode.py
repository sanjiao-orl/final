# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""decode.py —— 番茄 raw json → 解码清洗 → 工作区 md 章节（第二阶段，纯标准库零依赖）。

用法：uv run decode.py <raw_dir> <out_manuscript_dir>
  例：uv run decode.py .bench/raw/十日终焉 .bench/manuscript/十日终焉

- raw_dir：fetch.mjs 产物目录（<itemId>.json + _book.json + _directory.json）
- 解码：content 里的 PUA 码点按 font-map.json 还原（字体静态，映射表人工识读校准）
- 清洗：去 img 占位段、HTML 转段落、去噪声行
- 产出：<out>/<卷名>/<章题>.md（frontmatter：title/status: 语料/source/volume/order/wordNumber）
  + <raw_dir>/_decode-report.json（每章 CJK 数 vs 官方 chapterWordNumber、残留 PUA——QA 用）
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
FONT_MAP = json.loads((SCRIPT_DIR / "font-map.json").read_text(encoding="utf8"))["map"]
PUA_TABLE = {int(k, 16): v for k, v in FONT_MAP.items()}

NOISE = re.compile("(正在加载|加载下一章|点击下一页|继续阅读|本章完|请收藏|加入书签|请务必|防盗章节|image_type)")
ILLEGAL_FS = re.compile('[\\\\/:*?"<>|]')


def sanitize(name: str) -> str:
    name = ILLEGAL_FS.sub("·", str(name))
    name = "".join(c if ord(c) >= 32 else "·" for c in name)
    return re.sub(r"\s+", " ", name).strip()


def decode_text(s: str) -> str:
    return s.translate(PUA_TABLE)


def html_to_paras(content: str) -> list:
    s = re.sub(r"<br\s*/?>", "\n", content, flags=re.I)
    s = re.sub(r"</(p|div|section|h\d)>", "\n", s, flags=re.I)
    s = re.sub(r"<p[^>]*>", "\n", s, flags=re.I)
    paras = []
    for chunk in s.split("\n"):
        t = re.sub(r"<[^>]+>", "", chunk).strip()
        if t and not NOISE.search(t):
            paras.append(t)
    return paras


def count_cjk(text: str) -> int:
    return len(re.findall("[一-鿿]", text))


def main() -> None:
    raw_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    files = sorted(f for f in raw_dir.glob("*.json") if not f.name.startswith("_"))
    if not files:
        sys.exit(f"raw 目录无章节 json：{raw_dir}")
    book_file = raw_dir / "_book.json"
    book = json.loads(book_file.read_text(encoding="utf8")) if book_file.exists() else {}

    report = []
    written = 0
    skipped_truncated = 0
    for f in files:
        rec = json.loads(f.read_text(encoding="utf8"))
        paras = html_to_paras(decode_text(rec.get("content", "")))
        body = "\n\n".join(paras) + "\n"
        cjk = count_cjk("".join(paras))
        residual = sum(1 for c in body if 0xE000 <= ord(c) <= 0xF8FF)
        title = rec.get("title") or f"第{rec.get('order', '?')}章"
        vol = rec.get("volumeName") or "正文"
        wn = rec.get("chapterWordNumber") or 0
        # 反爬截断过滤：官方 wordNumber 与解码 CJK 差距过大（<0.5）即预览残章，不写库
        truncated = bool(wn) and cjk / float(wn) < 0.5
        if truncated:
            skipped_truncated += 1
        else:
            vol_dir = out_dir / sanitize(vol)
            vol_dir.mkdir(parents=True, exist_ok=True)
            fm = [
                "---",
                f"title: {title}",
                "status: 语料",
                f"source: 番茄小说《{rec.get('bookName', '')}》{book.get('author', '')} · {rec.get('sourceUrl', '')}",
                f"volume: {vol}",
                f"order: {rec.get('order')}",
                f"wordNumber: {rec.get('chapterWordNumber')}",
                "---",
                "",
            ]
            (vol_dir / f"{sanitize(title)}.md").write_text("\n".join(fm) + body, encoding="utf8", newline="\n")
            written += 1
        report.append(
            {
                "order": rec.get("order"),
                "title": title,
                "volume": vol,
                "cjk": cjk,
                "wordNumber": rec.get("chapterWordNumber"),
                "residualPua": residual,
                "truncated": truncated,
            }
        )

    (raw_dir / "_decode-report.json").write_text(
        json.dumps({"decodedAt": datetime.now().isoformat(), "chapters": report}, ensure_ascii=False, indent=1),
        encoding="utf8",
    )
    total = sum(r["cjk"] for r in report if not r.get("truncated"))
    bad = [r for r in report if r["residualPua"] > 0 and not r.get("truncated")]
    print(f"解码完成：{written} 章入库（截断残章跳过 {skipped_truncated}）→ {out_dir}，正文 CJK 合计 {total} 字")
    print(f"残留 PUA 章节数：{len(bad)}" + (f"（如 {[r['title'] for r in bad[:5]]}…）" if bad else ""))


if __name__ == "__main__":
    main()
