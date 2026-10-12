"""由固定版本思源黑体生成缺字测试夹具；需要 fonttools==4.63.0。"""
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
target = root / "fixtures/resources/font-subsets"
target.mkdir(parents=True, exist_ok=True)
for style in ("Regular", "Medium", "Bold"):
    font = TTFont(root / f"fixtures/resources/fonts/SourceHanSansCN-{style}.otf", recalcTimestamp=False)
    options = subset.Options()
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    options.name_legacy = True
    options.name_languages = [0x409]
    sub = subset.Subsetter(options=options)
    sub.populate(text=" AB田")
    sub.subset(font)
    family = "RenderWeave Test Subset"
    full = f"{family} {style}"
    postscript = f"RenderWeaveTestSubset-{style}"
    for record in font["name"].names:
        value = {1: family, 2: style, 3: postscript, 4: full, 6: postscript, 16: family, 17: style}.get(record.nameID)
        if value:
            record.string = value.encode(record.getEncoding())
    cff = font["CFF "].cff
    cff.fontNames = [postscript]
    cff.topDictIndex[0].FamilyName = family
    cff.topDictIndex[0].FullName = full
    font.save(target / f"TestSubset-{style}.otf")
