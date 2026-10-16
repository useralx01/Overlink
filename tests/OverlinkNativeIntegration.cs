using System;
using System.IO;
using System.Text;
using System.Reflection;
using System.Collections.Generic;
using System.Web.Script.Serialization;
class OverlinkNativeIntegration {
    public static int Main(string[] args) {
        if (args.Length != 3) {
            Console.Error.WriteLine("Usage: harness <native-exe> <safe-test-root> <synthetic-envelope.json>");
            return 2;
        }
        try {
            var exe = Path.GetFullPath(args[0]);
            var root = Path.GetFullPath(args[1]);
            var payload = Path.GetFullPath(args[2]);
            if (!File.Exists(exe) || !File.Exists(payload)) throw new Exception("Missing test input");
            if (!Directory.Exists(root)) throw new Exception("Test root missing");
            var json = new JavaScriptSerializer { MaxJsonLength = 130000 };
            var request = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(payload, Encoding.UTF8));
            var assembly = Assembly.LoadFrom(exe);
            var handler = assembly.GetType("VyrInbox", true);
            var method = handler.GetMethod("Store", BindingFlags.NonPublic | BindingFlags.Static);
            if (method == null) throw new Exception("Native transfer receiver not found");
            var receipt = method.Invoke(null, new object[] { root, request });
            Console.WriteLine(json.Serialize(receipt));
            return 0;
        } catch (TargetInvocationException ex) {
            Console.Error.WriteLine(ex.InnerException == null ? ex.Message : ex.InnerException.Message);
            return 1;
        } catch (Exception ex) {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }
}