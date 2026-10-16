using System;
using System.IO;
using System.Text;
using System.Reflection;
using System.Threading;
using System.Collections.Generic;
using System.Web.Script.Serialization;
class OverlinkNativeProbe {
    static MethodInfo Method(Type t, string name) {
        var method = t.GetMethod(name,BindingFlags.NonPublic|BindingFlags.Public|BindingFlags.Static);
        if(method==null)throw new Exception(name+" is missing");
        return method;
    }
    public static int Main(string[] args) {
        if(args.Length<2){Console.Error.WriteLine("Usage: health <exe> | snapshot <exe> <root> <relative.jsonl> <outputfile>");return 2;}
        try {
            var a=Assembly.LoadFrom(Path.GetFullPath(args[1]));
            if(args[0]=="health" && args.Length==2) {
                var settings=a.GetType("Settings",true);
                var c=Activator.CreateInstance(settings);
                settings.GetField("name").SetValue(c,"OverlinkValidation");
                var health=Method(a.GetType("PCLink",true),"HealthReport").Invoke(null,new[]{c});
                var serialized=new JavaScriptSerializer().Serialize(health);
                var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(serialized);
                if(!data.ContainsKey("cpuPercent") || !data.ContainsKey("availableRamBytes") ||
                   !data.ContainsKey("topProcesses") || !data.ContainsKey("drives"))
                    throw new Exception("Health telemetry incomplete");
                Console.WriteLine("HEALTH_OK ram_load="+data["memoryLoadPercent"]+" cpu="+data["cpuPercent"]);
                return 0;
            }
            if(args[0]=="snapshot" && args.Length==5) {
                var session=Method(a.GetType("VyrCodexSessions",true),"SnapshotText");
                string source=(string)session.Invoke(null,new object[]{Path.GetFullPath(args[2]),args[3],16000});
                if(source.Length==0 || !source.Contains("OVERLINK_SESSION_PROOF"))throw new Exception("Codex JSONL snapshot invalid");
                File.WriteAllText(Path.GetFullPath(args[4]),source,new UTF8Encoding(false));
                Console.WriteLine("SNAPSHOT_OK bytes="+Encoding.UTF8.GetByteCount(source));
                return 0;
            }
            if(args[0]=="recovery-denied" && args.Length==2) {
                var rec=Method(a.GetType("VyrRecovery",true),"Execute");
                var input=new Dictionary<string,object>{
                    {"action","terminate_approved_process"},{"pid",-1},
                    {"expected_name","OverlinkFakeProcess"},{"expected_started_utc","2026-01-01T00:00:00Z"}
                };
                try {rec.Invoke(null,new object[]{input});}
                catch(TargetInvocationException ex){
                    if(ex.InnerException!=null && ex.InnerException.Message.Contains("Invalid or protected process ID")){
                        Console.WriteLine("RECOVERY_DENIAL_OK");return 0;
                    }
                    throw;
                }
                throw new Exception("Unauthorized recovery was accepted");
            }
            throw new Exception("Unknown test mode");
        } catch(Exception ex) {Console.Error.WriteLine(ex.Message);return 1;}
    }
}