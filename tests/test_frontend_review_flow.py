"""前端逐条复核流程回归测试的 pytest 封装。

用例本体在 tests/test_review_flow.js：用最小 DOM 桩在 Node 虚拟机中加载真实
app/static/app.js，驱动「导入 / 逐条复核 / 改稿 / 重排 / 取消编辑 / 重新导入 /
恢复存档 / 复核稿下载」的真实事件处理器，覆盖复核记录建立、改稿按核对结果清除、
纯重排保留、改回旧文不恢复、新条款默认未复核、记录仅存本页内存（重新导入 /
成功恢复存档清空），以及复核稿下载等待期间改稿 / 换稿时旧响应不保存文件、
不影响新操作。这里通过 node --test 运行它；环境没有 Node 时跳过。
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node 运行前端单测")
def test_review_flow_frontend():
    r = subprocess.run(
        ["node", "--test", str(ROOT / "tests" / "test_review_flow.js")],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
