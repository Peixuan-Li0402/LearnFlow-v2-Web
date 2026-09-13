from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import black, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tests" / "fixtures" / "two-problem-assignment.pdf"


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    pdfmetrics.registerFont(TTFont("SimHei", r"C:\Windows\Fonts\simhei.ttf"))
    page = canvas.Canvas(str(OUTPUT), pagesize=A4)
    width, height = A4

    page.setFillColor(white)
    page.rect(0, 0, width, height, fill=1, stroke=0)
    page.setFillColor(black)
    page.setFont("SimHei", 18)
    page.drawString(64, height - 70, "微积分作业测试")
    page.setFont("SimHei", 13)
    page.drawString(64, height - 120, "第1题：求函数 f(x)=6-2x 在区间 [0,3] 上的平均值。")
    page.drawString(64, height - 150, "请写出所用公式、适用条件和完整计算过程。")
    page.showPage()

    page.setFillColor(white)
    page.rect(0, 0, width, height, fill=1, stroke=0)
    page.setFillColor(black)
    page.setFont("SimHei", 13)
    page.drawString(64, height - 90, "第2题：设随机变量 X 服从区间 (0,1) 上的均匀分布，")
    page.drawString(64, height - 120, "令 Y=-ln X，求 Y 的分布函数和概率密度函数。")
    page.save()


if __name__ == "__main__":
    main()
