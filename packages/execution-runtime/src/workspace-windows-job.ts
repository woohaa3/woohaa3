import path from "node:path";

// Windows Job Objects keep descendants in the same job, including children that
// outlive their parent. Create suspended -> assign -> resume closes the spawn race.
const runner = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WorkspaceJob {
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits BasicLimitInformation; public IO IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reserved2; public IntPtr reservedPtr, input, output, error; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
  [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits info, uint size);
  [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttr, IntPtr threadAttr, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string command, string cwd, string stop, string receipt) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
    ProcessInfo child = new ProcessInfo();
    try {
      Limits limits = new Limits(); limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
      Startup startup = new Startup(); startup.cb = (uint)Marshal.SizeOf(startup); startup.flags = 0x100;
      startup.input = GetStdHandle(-10); startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
      Check(CreateProcess(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 4 | 0x08000000, IntPtr.Zero, cwd, ref startup, out child));
      if (!AssignProcessToJobObject(job, child.process)) { TerminateProcess(child.process, 1); Check(false); }
      Check(ResumeThread(child.thread) != 0xffffffff);
      bool stopped = false;
      while (WaitForSingleObject(child.process, 50) == 258) {
        if (System.IO.File.Exists(stop)) { stopped = true; Check(TerminateJobObject(job, 1)); break; }
      }
      Check(WaitForSingleObject(child.process, 5000) == 0);
      uint code; Check(GetExitCodeProcess(child.process, out code));
      Check(TerminateJobObject(job, 1)); // Also drain background descendants after natural parent exit.
      Accounting accounting;
      for (int i=0; i<100; i++) {
        Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (accounting.ActiveProcesses == 0) {
          System.IO.File.WriteAllText(receipt, "{\"drained\":true,\"stopped\":" + (stopped ? "true" : "false") + ",\"exitCode\":" + code.ToString() + "}");
          return unchecked((int)code);
        }
        System.Threading.Thread.Sleep(50);
      }
      throw new Exception("Cannot prove Windows job termination");
    } finally {
      if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
      if (child.process != IntPtr.Zero) CloseHandle(child.process);
      CloseHandle(job);
    }
  }
}
'@
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
exit [WorkspaceJob]::Run($inputData.command, $inputData.cwd, $inputData.stop, $inputData.receipt)
`;

/** CommandLineToArgvW-compatible quoting; no PowerShell interpolation of model text. */
function quote(arg: string): string {
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
export function windowsWorkspaceJob(input: { command: string; args: string[]; cwd: string; shell: boolean; control: string; env: NodeJS.ProcessEnv }) {
  const command = input.shell
    ? `${quote(input.env.COMSPEC ?? path.win32.join(input.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"))} /d /s /c "${input.command} ${input.args.join(" ")}"`
    : [input.command, ...input.args].map(quote).join(" ");
  const payload = Buffer.from(JSON.stringify({ command, cwd: input.cwd, stop: `${input.control}.stop`, receipt: `${input.control}.json` })).toString("base64");
  return {
    command: path.win32.join(input.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(runner.replace("__PAYLOAD__", payload), "utf16le").toString("base64")]
  };
}
