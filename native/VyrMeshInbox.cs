using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Security.Cryptography;

static class VyrInbox {
    static readonly Regex IdPattern=new Regex("^[a-f0-9]{64}$",RegexOptions.Compiled);
    static readonly Regex FilePattern=new Regex("^[A-Za-z0-9][A-Za-z0-9_. -]{0,179}$",RegexOptions.Compiled);
    static string CheckId(string id) {
        if(id==null || !IdPattern.IsMatch(id))throw new Exception("Invalid transfer ID");
        return id;
    }
    static string CheckFilename(string filename) {
        if(String.IsNullOrWhiteSpace(filename) || filename.EndsWith(".") || filename.EndsWith(" ") ||
           filename.Contains("..") || !FilePattern.IsMatch(filename))
            throw new Exception("Invalid transfer file name");
        return filename;
    }
    static string Hash(byte[] bytes) {
        using(var sha=SHA256.Create()){
            var hash=sha.ComputeHash(bytes);
            var sb=new StringBuilder(hash.Length*2);
            foreach(var b in hash)sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }
    internal static object Store(string root,Dictionary<string,object> transfer) {
        string id=CheckId(PCLink.Arg(transfer,"id",""));
        string kind=PCLink.Arg(transfer,"kind","text");
        string content=PCLink.Arg(transfer,"content","");
        if(content.Length>90000)throw new Exception("Transfer content too large");
        var inbox=PCLink.Resolve(root,"Overlink\\inbox");
        Directory.CreateDirectory(inbox);
        string envelope=PCLink.Resolve(root,"Overlink\\inbox\\"+id+".json");
        bool stored=false;
        if(!File.Exists(envelope)){
            byte[] raw=Encoding.UTF8.GetBytes(PCLink.Json.Serialize(transfer));
            if(raw.Length>120000)throw new Exception("Envelope too large");
            using(var stream=new FileStream(envelope,FileMode.CreateNew,FileAccess.Write,FileShare.None))
                stream.Write(raw,0,raw.Length);
            stored=true;
        }
        string savedFile=null;
        if(kind=="file"){
            string filename=CheckFilename(PCLink.Arg(transfer,"filename",""));
            if(!Regex.IsMatch(content,@"\A(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\z"))
                throw new Exception("File data is not valid base64");
            var data=Convert.FromBase64String(content);
            if(data.Length>70000)throw new Exception("File payload exceeds local limit");
            string destination=PCLink.Resolve(root,"Overlink\\received\\"+id.Substring(0,16)+"-"+filename);
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            PCLink.Resolve(root,"Overlink\\received\\"+id.Substring(0,16)+"-"+filename);
            if(!File.Exists(destination)) {
                using(var stream=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None))
                    stream.Write(data,0,data.Length);
            } else {
                if(Hash(File.ReadAllBytes(destination))!=Hash(data))
                    throw new Exception("Existing file differs from delivered transfer; no overwrite.");
            }
            savedFile=destination;
        }
        return new {ok=true,stored=stored,envelope=envelope,savedFile=savedFile};
    }
    internal static object SendFile(Dictionary<string,object> a,Settings c,System.Threading.CancellationToken token) {
        string relative=PCLink.Arg(a,"path","");
        string device=PCLink.Arg(a,"target_device","");
        string requestId=PCLink.Arg(a,"request_id","");
        Guid parsed;
        if(!Guid.TryParse(device,out parsed))throw new Exception("Destination PC ID is invalid.");
        if(String.IsNullOrWhiteSpace(requestId)||requestId.Length>128)throw new Exception("Stable request_id required.");
        string path=PCLink.Resolve(c.root,relative);
        var file=new FileInfo(path);
        if(!file.Exists || file.Length>60000)throw new Exception("File must exist and be under 60 KB.");
        string filename=CheckFilename(file.Name);
        byte[] bytes=File.ReadAllBytes(path);
        if(bytes.Length>60000)throw new Exception("File changed during transfer.");
        string encoded=Convert.ToBase64String(bytes);
        var response=PCLink.Post("/device/transfer/send",new {
            id=c.id, target_device=device, request_id=requestId,
            kind="file", title="File from "+c.name,
            filename=filename, content=encoded
        },c,token).GetAwaiter().GetResult();
        return new{ok=true,bytes=bytes.Length,sha256=Hash(bytes),filename=filename,receipt=response};
    }
    internal static bool SelfTest() {
        string root=Path.Combine(Path.GetTempPath(),"vyrmesh-inbox-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            var row=new Dictionary<string,object> {
                {"id",new string('a',64)},{"kind","file"},{"filename","test.txt"},
                {"content",Convert.ToBase64String(Encoding.UTF8.GetBytes("abc"))}
            };
            Store(root,row);
            var saved=Path.Combine(root,"Overlink","received",new string('a',16)+"-test.txt");
            if(!File.Exists(saved)||File.ReadAllText(saved)!="abc")return false;
            Store(root,row);
            row["filename"]="bad:stream.txt";
            try {Store(root,row);return false;} catch {}
            return true;
        } finally {Directory.Delete(root,true);}
    }
}
