using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Threading;

static class VyrCodexSessions {
    static string Root {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "sessions"); }
    }
    static string ResolveSession(string root, string relative) {
        if (String.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) || relative.IndexOf(':')>=0 ||
            relative.IndexOf('\0')>=0 || !relative.EndsWith(".jsonl",StringComparison.OrdinalIgnoreCase))
            throw new Exception("Expected a relative Codex .jsonl session file.");
        string basePath=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
        string full=Path.GetFullPath(Path.Combine(basePath,relative));
        if (!full.StartsWith(basePath,StringComparison.OrdinalIgnoreCase))
            throw new Exception("Session path escapes the Codex sessions folder.");
        string cursor=full;
        while (!String.IsNullOrEmpty(cursor) && cursor.StartsWith(basePath,StringComparison.OrdinalIgnoreCase)) {
            if ((File.Exists(cursor)||Directory.Exists(cursor)) && (File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0)
                throw new Exception("Linked session files and junctions are not allowed.");
            string parent=Path.GetDirectoryName(cursor);
            if(parent==cursor)break;
            cursor=parent;
        }
        return full;
    }
    internal static object List() {
        var results=new List<object>();
        if (!Directory.Exists(Root)) return new {ok=true,sessions=results,count=0};
        var files=Directory.EnumerateFiles(Root,"*.jsonl",SearchOption.AllDirectories)
            .Select(p=>new FileInfo(p)).OrderByDescending(f=>f.LastWriteTimeUtc).Take(20);
        foreach(var file in files){
            try {
                string path=file.FullName.Substring(Root.Length+1);
                ResolveSession(Root,path);
                results.Add(new{path=path.Replace('\\','/'),modifiedUtc=file.LastWriteTimeUtc.ToString("o"),
                    bytes=file.Length});
            } catch {}
        }
        return new {ok=true,sessions=results,count=results.Count};
    }
    internal static string SnapshotText(string root,string path,int maxBytes) {
        string file=ResolveSession(root,path);
        maxBytes=Math.Max(1024,Math.Min(60000,maxBytes));
        byte[] buffer;
        using(var fs=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite)) {
            int size=(int)Math.Min(fs.Length,maxBytes);
            if(size<=0)return "";
            fs.Seek(-size,SeekOrigin.End);
            buffer=new byte[size];
            int read=0;
            while(read<size) {
                int n=fs.Read(buffer,read,size-read);
                if(n<=0)break;
                read+=n;
            }
            if(read!=size)Array.Resize(ref buffer,read);
        }
        string text=new UTF8Encoding(false,false).GetString(buffer);
        int first=text.IndexOf('\n');
        if(new FileInfo(file).Length>buffer.Length && first>=0)text=text.Substring(first+1);
        return text;
    }
    internal static object Execute(Dictionary<string,object> a,Settings c,CancellationToken token) {
        string action=PCLink.Arg(a,"action","");
        if(action=="list") return List();
        if(action!="snapshot" && action!="handoff")throw new Exception("Valid Codex actions: list, snapshot, handoff.");
        string path=PCLink.Arg(a,"path","");
        string data=SnapshotText(Root,path,58000);
        string payload=PCLink.Json.Serialize(new {
            source="Codex", from=c.name, session=path, capturedUtc=DateTime.UtcNow.ToString("o"),
            kind="recent-session-records", truncated=true, rawJsonLines=data
        });
        if(action=="snapshot") return new {ok=true,content=payload,bytes=Encoding.UTF8.GetByteCount(payload)};
        string device=PCLink.Arg(a,"target_device","");
        string request=PCLink.Arg(a,"request_id","");
        Guid parsed;
        if(!Guid.TryParse(device,out parsed))throw new Exception("Invalid target device.");
        if(String.IsNullOrWhiteSpace(request)||request.Length>128)throw new Exception("A stable request_id is required.");
        var receipt=PCLink.Post("/device/transfer/send",new {
            id=c.id,target_device=device,kind="handoff",title="Codex session from "+c.name,
            content=payload,request_id=request
        },c,token).GetAwaiter().GetResult();
        return new {ok=true,receipt=receipt,bytes=Encoding.UTF8.GetByteCount(payload)};
    }
    internal static bool SelfTest() {
        string root=Path.Combine(Path.GetTempPath(),"vyrmesh-test-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            Directory.CreateDirectory(Path.Combine(root,"2026"));
            File.WriteAllText(Path.Combine(root,"2026","test.jsonl"),"{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n");
            if(!SnapshotText(root,"2026/test.jsonl",4096).Contains("assistant"))return false;
            try{SnapshotText(root,"../secrets.jsonl",4096);return false;}catch{}
            return true;
        } finally {Directory.Delete(root,true);}
    }
}
