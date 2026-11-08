using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;

namespace AgentOS.Computer
{
    internal static class ScopedWindowBrokerTests
    {
        const string Target = "af:123";

        static void Check(bool expected, bool authorized, string operation, string windowId)
        {
            var args = new Dictionary<string, object>();
            if (windowId != null) args["windowId"] = windowId;
            bool allowed = true;
            try { ScopedWindowBroker.ValidateRequest(Target, authorized, operation, args); }
            catch (InvalidOperationException) { allowed = false; }
            catch (ArgumentException) { allowed = false; }
            if (allowed != expected) throw new Exception("Unexpected scope policy: " + operation + " " + windowId);
        }

        static Process Child(string args)
        {
            return Process.Start(new ProcessStartInfo {
                FileName = Assembly.GetExecutingAssembly().Location, Arguments = args,
                UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, CreateNoWindow = true
            });
        }

        static void CheckAcl(NamedPipeServerStream pipe)
        {
            var network = new SecurityIdentifier(WellKnownSidType.NetworkSid, null);
            var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            bool adminAccess = false, networkDenied = false;
            foreach (PipeAccessRule rule in pipe.GetAccessControl().GetAccessRules(true, false, typeof(SecurityIdentifier)))
            {
                if (rule.IdentityReference.Equals(network) && rule.AccessControlType == AccessControlType.Deny)
                    networkDenied = (rule.PipeAccessRights & PipeAccessRights.FullControl) == PipeAccessRights.FullControl;
                if (rule.IdentityReference.Equals(administrators) && rule.AccessControlType == AccessControlType.Allow)
                    adminAccess = (rule.PipeAccessRights & PipeAccessRights.ReadWrite) == PipeAccessRights.ReadWrite &&
                        (rule.PipeAccessRights & (PipeAccessRights.CreateNewInstance | PipeAccessRights.ChangePermissions |
                            PipeAccessRights.TakeOwnership)) == 0;
            }
            if (!adminAccess || !networkDenied) throw new Exception("Unexpected local administrator pipe ACL.");
        }

        static void CheckPipe()
        {
            string nonce = Guid.NewGuid().ToString("N");
            int self = Process.GetCurrentProcess().Id;
            using (var pipe = ScopedWindowBroker.CreatePipe(nonce))
            {
                CheckAcl(pipe);
                using (var client = Child("pipe " + self + " " + nonce))
                    Handshake(pipe, client, self);
            }
        }

        static void Handshake(NamedPipeServerStream pipe, Process client, int self)
        {
            try
            {
                var connected = pipe.BeginWaitForConnection(null, null);
                if (!connected.AsyncWaitHandle.WaitOne(4000)) throw new Exception("The fixture pipe did not connect.");
                pipe.EndWaitForConnection(connected);
                ScopedWindowBroker.VerifyPeer(pipe.SafePipeHandle, true, client.Id);
                bool rejected = false;
                try { ScopedWindowBroker.VerifyPeer(pipe.SafePipeHandle, true, self); }
                catch (InvalidOperationException) { rejected = true; }
                if (!rejected) throw new Exception("Accepted a different named pipe peer.");
                if (pipe.ReadByte() != 79) throw new Exception("Worker handshake failed.");
                pipe.RunAsClient(delegate {
                    using (var identity = WindowsIdentity.GetCurrent())
                        if (identity.ImpersonationLevel > TokenImpersonationLevel.Identification)
                            throw new Exception("Relay could impersonate the worker.");
                });
                pipe.WriteByte(75);
                if (!client.WaitForExit(4000) || client.ExitCode != 0) throw new Exception("Pipe reply failed.");
            }
            finally { if (!client.HasExited) { client.Kill(); client.WaitForExit(2000); } }
        }

        static void CheckParentDeath()
        {
            using (var relay = Child("relay"))
            using (var worker = Process.GetProcessById(Int32.Parse(relay.StandardOutput.ReadLine())))
            {
                try
                {
                    if (worker.HasExited || worker.Handle == IntPtr.Zero) throw new Exception("Worker exited before its relay.");
                    relay.StandardInput.Close();
                    if (!relay.WaitForExit(3000) || !worker.WaitForExit(3000) || worker.ExitCode != 0)
                        throw new Exception("The blocked worker survived its relay.");
                }
                finally { if (!worker.HasExited) worker.Kill(); }
            }
        }

        static void CheckStopCode()
        {
            string nonce = Guid.NewGuid().ToString("N");
            using (var pipe = ScopedWindowBroker.CreatePipe(nonce))
            using (var worker = Child("stop " + nonce))
            {
                pipe.WaitForConnection();
                int status = ScopedWindowBroker.Forward(pipe, worker, "begin",
                    delegate { Thread.Sleep(8000); return "end"; }, delegate { throw new Exception("Unexpected reply."); });
                if (status != 42) throw new Exception("Emergency stop exit code did not reach the relay.");
            }
        }

        static void Run(string[] args)
        {
            if (args.Length != 0)
            {
                if (args[0] == "pipe")
                {
                    using (var pipe = ScopedWindowBroker.OpenWorkerPipe(args[2]))
                    {
                        pipe.Connect(4000);
                        ScopedWindowBroker.VerifyPeer(pipe.SafePipeHandle, false, Int32.Parse(args[1]));
                        pipe.WriteByte(79);
                        if (pipe.ReadByte() != 75) throw new Exception("Relay handshake failed.");
                    }
                }
                else if (args[0] == "stop")
                {
                    using (var pipe = ScopedWindowBroker.OpenWorkerPipe(args[1]))
                    {
                        pipe.Connect(4000);
                        if (new StreamReader(pipe).ReadLine() != "begin") throw new Exception("Missing first command.");
                        Environment.Exit(42);
                    }
                }
                else if (args[0] == "watch")
                {
                    using (var parent = ScopedWindowBroker.PinProcess(Int32.Parse(args[1])))
                    {
                        ScopedWindowBroker.WatchParent(parent);
                        Console.WriteLine("ready");
                        // A hard bound also cleans up if the monitor regresses.
                        Thread.Sleep(8000);
                        throw new Exception("Parent monitor missed process exit.");
                    }
                }
                else if (args[0] == "relay")
                {
                    using (var worker = Child("watch " + Process.GetCurrentProcess().Id))
                    {
                        if (worker.StandardOutput.ReadLine() != "ready") throw new Exception("Worker did not arm.");
                        Console.WriteLine(worker.Id);
                        Console.ReadLine();
                    }
                }
                return;
            }
            Check(true, false, "authorize_window", Target);
            Check(false, false, "authorize_window", "af:124");
            Check(false, true, "authorize_window", Target);
            foreach (var operation in new[] { "capture_window", "observe_window", "observe_target_tree",
                "activate_window", "click", "invoke_control", "select_item" })
            {
                Check(false, false, operation, Target);
                Check(true, true, operation, Target);
                Check(false, true, operation, null);
                Check(false, true, operation, "af:124");
                Check(false, true, operation, "a0:123");
            }
            foreach (var operation in new[] { "type_text", "shortcut", "set_value", "list_windows", "list_displays", "capture_display", "input_access", "" })
                Check(false, true, operation, Target);
            foreach (var operation in new[] { "release_control", "finish_visual" })
            {
                Check(false, false, operation, null);
                Check(true, true, operation, null);
                Check(false, true, operation, "af:124");
            }
            CheckPipe();
            CheckParentDeath();
            CheckStopCode();
        }

        static int Main(string[] args)
        {
            try { Run(args); return 0; }
            catch (Exception ex) { Console.Error.WriteLine(ex.GetType().Name + ": " + ex.Message); return 1; }
        }
    }
}
