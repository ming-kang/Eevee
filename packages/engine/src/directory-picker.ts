import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { PickDirectoryRequest, PickDirectoryResponse } from "@eevee/protocol";
import { EngineError } from "./engine-error.ts";

export type PickerCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly errorCode?: string;
};

export type PickerCommandRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
  },
) => Promise<PickerCommandResult>;

export type DirectoryPickerOptions = {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: PickerCommandRunner;
};

export type DirectoryPicker = {
  pick(input?: PickDirectoryRequest, signal?: AbortSignal): Promise<PickDirectoryResponse>;
};

const WINDOWS_PICKER_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$title = $env:EEVEE_PICKER_TITLE
$initial = $env:EEVEE_PICKER_INITIAL_PATH
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$code = @"
using System;
using System.Runtime.InteropServices;

public static class EeveeFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
  private class FileOpenDialog {}

  [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  private static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem ppv);

  private const uint FOS_PICKFOLDERS = 0x00000020;
  private const uint FOS_FORCEFILESYSTEM = 0x00000040;
  private const uint FOS_PATHMUSTEXIST = 0x00000800;
  private const uint SIGDN_FILESYSPATH = 0x80058000;
  private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

  public static string Pick(IntPtr owner, string title, string initialPath) {
    var dialog = (IFileOpenDialog)new FileOpenDialog();
    try {
      uint options;
      dialog.GetOptions(out options);
      dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
      if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
      if (!string.IsNullOrEmpty(initialPath)) {
        var iid = typeof(IShellItem).GUID;
        IShellItem folder;
        if (SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref iid, out folder) == 0 && folder != null) {
          dialog.SetFolder(folder);
        }
      }
      int hr = dialog.Show(owner);
      if (hr == ERROR_CANCELLED) return null;
      if (hr < 0) Marshal.ThrowExceptionForHR(hr);
      IShellItem result;
      dialog.GetResult(out result);
      string path;
      result.GetDisplayName(SIGDN_FILESYSPATH, out path);
      return path;
    } finally {
      Marshal.ReleaseComObject(dialog);
    }
  }
}
"@

$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Opacity = 0
$owner.ShowInTaskbar = $false
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$owner.Activate()

try {
  $picked = $null
  try {
    Add-Type -TypeDefinition $code -ErrorAction Stop
    $picked = [EeveeFolderPicker]::Pick($owner.Handle, $title, $initial)
  } catch {
    $fallback = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($title) { $fallback.Description = $title }
    if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) {
      $fallback.SelectedPath = $initial
    }
    if ($fallback.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
      $picked = $fallback.SelectedPath
    }
  }
  if ($picked) {
    [Console]::Out.Write($picked)
    exit 0
  }
  exit 2
} finally {
  $owner.Close()
  $owner.Dispose()
}
`;

const MACOS_PICKER_SCRIPT = [
  "on run argv",
  "  set promptText to item 1 of argv",
  "  set defaultDir to item 2 of argv",
  '  if defaultDir is not "" then',
  "    try",
  "      return POSIX path of (choose folder with prompt promptText default location (POSIX file defaultDir))",
  "    end try",
  "  end if",
  "  return POSIX path of (choose folder with prompt promptText)",
  "end run",
].join("\n");

function defaultRunner(
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly signal?: AbortSignal },
): Promise<PickerCommandResult> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      [...args],
      {
        env: options.env,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ stdout, stderr, code: 0 });
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: string | number };
        const numericCode = typeof err.code === "number" ? err.code : null;
        const stringCode = typeof err.code === "string" ? err.code : undefined;
        resolvePromise({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: numericCode,
          ...(stringCode === undefined ? {} : { errorCode: stringCode }),
        });
      },
    );
  });
}

async function resolveInitialDirectory(initialPath: string | undefined): Promise<string> {
  if (initialPath === undefined || initialPath.trim().length === 0) return "";
  const candidate = resolve(initialPath.trim());
  try {
    const info = await stat(candidate);
    if (info.isDirectory()) return candidate;
  } catch {}
  return "";
}

function normalizePickedPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 1 && trimmed.endsWith("/") && !/^[a-zA-Z]:\/$/.test(trimmed)) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

async function pickWindows(
  runner: PickerCommandRunner,
  env: NodeJS.ProcessEnv,
  title: string,
  initialPath: string,
  signal?: AbortSignal,
): Promise<PickDirectoryResponse> {
  const encoded = Buffer.from(WINDOWS_PICKER_SCRIPT, "utf16le").toString("base64");
  const result = await runner(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
    {
      env: {
        ...env,
        EEVEE_PICKER_TITLE: title,
        EEVEE_PICKER_INITIAL_PATH: initialPath,
      },
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (result.errorCode === "ABORT_ERR") {
    return { path: null, cancelled: true };
  }
  if (result.errorCode === "ENOENT") {
    throw new EngineError(
      501,
      "picker_unavailable",
      "Windows directory picker is unavailable (powershell.exe not found)",
    );
  }
  if (result.code === 2) {
    return { path: null, cancelled: true };
  }
  if (result.code !== 0) {
    throw new EngineError(
      500,
      "picker_failed",
      "Failed to open native directory picker",
      result.stderr.trim() || undefined,
    );
  }
  const picked = normalizePickedPath(result.stdout);
  return picked === null ? { path: null, cancelled: true } : { path: picked, cancelled: false };
}

async function pickMacos(
  runner: PickerCommandRunner,
  env: NodeJS.ProcessEnv,
  title: string,
  initialPath: string,
  signal?: AbortSignal,
): Promise<PickDirectoryResponse> {
  const result = await runner("osascript", ["-e", MACOS_PICKER_SCRIPT, "--", title, initialPath], {
    env,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.errorCode === "ABORT_ERR") {
    return { path: null, cancelled: true };
  }
  if (result.errorCode === "ENOENT") {
    throw new EngineError(
      501,
      "picker_unavailable",
      "macOS directory picker is unavailable (osascript not found)",
    );
  }
  if (result.code !== 0) {
    if (result.stderr.includes("-128") || /user canceled/i.test(result.stderr)) {
      return { path: null, cancelled: true };
    }
    throw new EngineError(
      500,
      "picker_failed",
      "Failed to open native directory picker",
      result.stderr.trim() || undefined,
    );
  }
  const picked = normalizePickedPath(result.stdout);
  return picked === null ? { path: null, cancelled: true } : { path: picked, cancelled: false };
}

async function pickLinux(
  runner: PickerCommandRunner,
  env: NodeJS.ProcessEnv,
  title: string,
  initialPath: string,
  signal?: AbortSignal,
): Promise<PickDirectoryResponse> {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new EngineError(
      501,
      "picker_unavailable",
      "Native directory picker requires an active desktop session",
    );
  }

  const zenityArgs = ["--file-selection", "--directory", `--title=${title}`];
  if (initialPath) {
    zenityArgs.push(`--filename=${initialPath.endsWith("/") ? initialPath : `${initialPath}/`}`);
  }
  const zenity = await runner("zenity", zenityArgs, {
    env,
    ...(signal === undefined ? {} : { signal }),
  });
  if (zenity.errorCode === "ABORT_ERR") {
    return { path: null, cancelled: true };
  }
  if (zenity.errorCode !== "ENOENT") {
    if (zenity.code === 1) return { path: null, cancelled: true };
    if (zenity.code !== 0) {
      throw new EngineError(
        500,
        "picker_failed",
        "Failed to open native directory picker",
        zenity.stderr.trim() || undefined,
      );
    }
    const picked = normalizePickedPath(zenity.stdout);
    return picked === null ? { path: null, cancelled: true } : { path: picked, cancelled: false };
  }

  const kdialogStart = initialPath || homedir();
  const kdialog = await runner(
    "kdialog",
    ["--getexistingdirectory", kdialogStart, "--title", title],
    {
      env,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (kdialog.errorCode === "ABORT_ERR") {
    return { path: null, cancelled: true };
  }
  if (kdialog.errorCode === "ENOENT") {
    throw new EngineError(
      501,
      "picker_unavailable",
      "Native directory picker is unavailable (neither zenity nor kdialog is installed)",
    );
  }
  if (kdialog.code === 1) return { path: null, cancelled: true };
  if (kdialog.code !== 0) {
    throw new EngineError(
      500,
      "picker_failed",
      "Failed to open native directory picker",
      kdialog.stderr.trim() || undefined,
    );
  }
  const picked = normalizePickedPath(kdialog.stdout);
  return picked === null ? { path: null, cancelled: true } : { path: picked, cancelled: false };
}

export function createDirectoryPicker(options: DirectoryPickerOptions = {}): DirectoryPicker {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  let busy = false;

  return {
    async pick(input?: PickDirectoryRequest, signal?: AbortSignal): Promise<PickDirectoryResponse> {
      if (busy) {
        throw new EngineError(409, "picker_busy", "A directory picker dialog is already open");
      }
      busy = true;
      try {
        const title = input?.title?.trim() || "Select Workspace Folder";
        const initialPath = await resolveInitialDirectory(input?.initialPath);
        if (platform === "win32") {
          return await pickWindows(runner, env, title, initialPath, signal);
        }
        if (platform === "darwin") {
          return await pickMacos(runner, env, title, initialPath, signal);
        }
        return await pickLinux(runner, env, title, initialPath, signal);
      } finally {
        busy = false;
      }
    },
  };
}
