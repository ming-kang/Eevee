export type ShortcutRow = { readonly keys: readonly string[]; readonly desc: string };
export type ShortcutGroup = { readonly group: string; readonly rows: readonly ShortcutRow[] };

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
}

export function modLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

export function shortcutGroups(): readonly ShortcutGroup[] {
  const mod = modLabel();
  return [
    {
      group: "全局导航",
      rows: [
        { keys: [mod, "K"], desc: "打开命令面板" },
        { keys: [mod, "B"], desc: "折叠 / 展开左侧栏" },
        { keys: [mod, "Alt", "B"], desc: "折叠 / 展开右侧 Workers 面板" },
        { keys: ["?"], desc: "打开快捷键速查表" },
      ],
    },
    {
      group: "对话与搜索",
      rows: [
        { keys: [mod, "F"], desc: "在当前对话中查找" },
        { keys: ["Enter"], desc: "发送消息（查找时跳到下一个匹配）" },
        { keys: ["Shift", "Enter"], desc: "换行（查找时跳到上一个匹配）" },
        { keys: [mod, "Enter"], desc: "运行中切换 steer / followUp 发送" },
        { keys: ["Esc", "Esc"], desc: "打断当前正在执行的回合" },
      ],
    },
    {
      group: "提问与面板",
      rows: [
        { keys: ["1–9"], desc: "快速选择当前问题的第 N 个选项" },
        { keys: ["Esc"], desc: "返回 Workers 列表 / 关闭弹层" },
        { keys: [mod, "S"], desc: "在项目记忆页保存更改" },
      ],
    },
  ];
}
