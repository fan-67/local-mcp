import aiohttp

from astrbot.api import star
from astrbot.api.event import AstrMessageEvent, MessageEventResult
from astrbot.core.config.default import VERSION
from astrbot.core.star import command_management
from astrbot.core.utils.io import get_dashboard_version

_ZH = {
    "name": "改名 (设置当前会话昵称)",
    "new": "新对话 (不继承上文/不受平台限制)",
    "provider": "查看/切换 LLM 模型",
    "reset": "重置对话上下文",
    "sid": "查看会话 ID 等信息",
    "stats": "当前对话 Token 用量统计",
    "stop": "停止 / 暂停 / 终止执行",
    "set": "设置会话变量",
    "unset": "删除会话变量",
}

_SKIP = {"set", "unset", "help", "dashboard_update", "h", "helpall"}


class HelpCommand:
    def __init__(self, context: star.Context) -> None:
        self.context = context

    async def _query_astrbot_notice(self):
        try:
            async with aiohttp.ClientSession(trust_env=True) as session:
                async with session.get(
                    "https://astrbot.app/notice.json",
                    timeout=2,
                ) as resp:
                    return (await resp.json())["notice"]
        except BaseException:
            return ""

    async def _build_reserved_command_lines(self) -> list[str]:
        """实时生成内置指令清单，支持 i18n 翻译。"""
        try:
            commands = await command_management.list_commands()
        except BaseException:
            return []

        lines: list[str] = []

        def walk(items: list[dict], indent: int = 0) -> None:
            for item in items:
                if not item.get("reserved") or not item.get("enabled"):
                    continue
                if item.get("type") == "sub_command":
                    continue
                if item.get("parent_signature"):
                    continue

                effective = (
                    item.get("effective_command")
                    or item.get("original_command")
                    or item.get("handler_name")
                )
                if not effective or effective in _SKIP:
                    continue

                description = _ZH.get(effective) or item.get("description") or ""
                desc_text = f" - {description}" if description else ""
                indent_prefix = "  " * indent
                lines.append(f"{indent_prefix}/{effective}{desc_text}")

        walk(commands)
        return lines

    async def help(self, event: AstrMessageEvent) -> None:
        """查看帮助"""
        notice = ""
        try:
            notice = await self._query_astrbot_notice()
        except BaseException:
            pass

        dashboard_version = await get_dashboard_version()
        command_lines = await self._build_reserved_command_lines()
        commands_section = (
            "\n".join(command_lines)
            if command_lines
            else "无启用的内置指令。"
        )

        msg_parts = [
            f"AstrBot v{VERSION}(WebUI: {dashboard_version})",
            commands_section,
            "",
            "💡 更多指令请发送 /h 或 /helpall",
        ]
        if notice:
            msg_parts.append(notice)
        msg = "\n".join(msg_parts)

        event.set_result(MessageEventResult().message(msg).use_t2i(False))
