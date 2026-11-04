"""合成批注工作簿，供公开 CLI/导入测试使用；不含用户资料。"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import sys

path, variant = Path(sys.argv[1]), sys.argv[2]
ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
pkg = 'http://schemas.openxmlformats.org/package/2006/relationships'
parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets><sheet name="测试表" sheetId="1" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{pkg}"><Relationship Id="r1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{ns}" xmlns:r="{rel}"><dimension ref="A1:C3"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>甲</t></is></c></row></sheetData><legacyDrawing r:id="v1"/></worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels': f'<Relationships xmlns="{pkg}"><Relationship Id="c1" Type="{rel}/comments" Target="../comments1.xml"/><Relationship Id="v1" Type="{rel}/vmlDrawing" Target="../drawings/notes.vml"/></Relationships>',
    'xl/comments1.xml': f'<comments xmlns="{ns}"><authors><author>测试作者</author></authors><commentList><comment ref="B2" authorId="0"><text><r><t xml:space="preserve"> 制作\n</t></r><r><t xml:space="preserve">甲 &amp; &lt;script&gt;test&lt;/script&gt; </t></r></text></comment><comment ref="C3" authorId="0"><text><t></t></text></comment></commentList></comments>',
}
shape = lambda ident, row, col: f'<v:shape id="{ident}" type="#note"><v:textbox><div/></v:textbox><x:ClientData ObjectType="Note"><x:Row>{row}</x:Row><x:Column>{col}</x:Column><x:Anchor>0,0,0,0,4,0,4,0</x:Anchor><x:Visible/></x:ClientData></v:shape>'
vml = '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shapetype id="note"/>'+shape('n1',1,1)+shape('n2',2,2)+'</xml>'
if variant == 'wrong-anchor': vml = vml.replace('<x:Row>1</x:Row>', '<x:Row>0</x:Row>')
if variant == 'duplicate-anchor': vml = vml.replace(shape('n2',2,2), shape('n2',1,1))
if variant == 'missing-anchor': vml = vml.replace(shape('n2',2,2),'')
if variant == 'foreign-shape': vml = vml.replace('</xml>', '<v:rect id="other"/></xml>')
if variant == 'control': vml = vml.replace('ObjectType="Note"','ObjectType="Button"',1)
if variant == 'image': vml = vml.replace('<v:textbox>', '<v:imagedata src="secret.png"/><v:textbox>',1)
if variant == 'dtd': vml = '<!DOCTYPE xml [<!ENTITY test "unsafe">]>'+vml
if variant == 'malformed': vml = vml[:-6]
if variant == 'hidden-flag': vml = vml.replace('<x:Visible/>','<x:Visible>false</x:Visible>')
parts['xl/drawings/notes.vml'] = vml
if variant == 'external-rel': parts['xl/worksheets/_rels/sheet1.xml.rels'] = parts['xl/worksheets/_rels/sheet1.xml.rels'].replace('Target="../comments1.xml"','Target="https://invalid.test/comments.xml" TargetMode="External"')
if variant == 'traversal-rel': parts['xl/worksheets/_rels/sheet1.xml.rels'] = parts['xl/worksheets/_rels/sheet1.xml.rels'].replace('../comments1.xml','../../../comments1.xml')
if variant == 'duplicate-comment': parts['xl/comments1.xml'] = parts['xl/comments1.xml'].replace('ref="C3"','ref="B2"')
if variant == 'changed-comment': parts['xl/comments1.xml'] = parts['xl/comments1.xml'].replace(' 制作',' 已篡改')
if variant == 'mapping': parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('<t>甲</t>', '<t> 冷藏、易碎、冷藏 </t>')
if variant == 'unknown-part': parts['xl/drawings/other.xml'] = '<unknown/>'
if variant == 'orphan': parts['xl/comments2.xml'] = parts['xl/comments1.xml']
if variant == 'no-vml':
    del parts['xl/drawings/notes.vml']
    parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('<legacyDrawing r:id="v1"/>','')
    parts['xl/worksheets/_rels/sheet1.xml.rels'] = parts['xl/worksheets/_rels/sheet1.xml.rels'].replace(f'<Relationship Id="v1" Type="{rel}/vmlDrawing" Target="../drawings/notes.vml"/>','')
with ZipFile(path,'x',ZIP_DEFLATED) as z:
    z.writestr('xl/drawings/','')
    for name, content in parts.items(): z.writestr(name,content.encode('utf8'))
