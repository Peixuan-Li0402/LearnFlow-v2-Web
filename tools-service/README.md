# LearnFlow 工具服务

这是 v2 的可选 Python/FastAPI 服务。Cloudflare Worker 仍负责 Agent 编排、状态与网页 API；本服务只做可验证的确定性工具调用：

- PDF/PPTX/DOCX 结构解析；
- SymPy 化简、求导、积分、极限、方程求解、代回和等价验证；
- Matplotlib 函数绘图；
- Pint 单位换算；
- Judge0 沙箱代理（不评分）。

启动：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:TOOL_SERVICE_TOKEN='请设置一个随机令牌'
uvicorn app:app --host 127.0.0.1 --port 8010
```

网页端配置：

```env
DOCUMENT_SERVICE_URL=http://127.0.0.1:8010
DOCUMENT_SERVICE_TOKEN=与上面相同
TOOL_SERVICE_URL=http://127.0.0.1:8010
TOOL_SERVICE_TOKEN=与上面相同
```

如需 OJ 执行，另行配置 `JUDGE0_BASE_URL`。代码不会直接在本服务宿主机进程中执行。
