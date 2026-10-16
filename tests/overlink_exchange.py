from pathlib import Path
import base64, hashlib, json, os, sys
root=Path(__file__).resolve().parents[1]
folder=root/"tests"/"overlink-e2e"
folder.mkdir(parents=True,exist_ok=True)
if len(sys.argv)!=3:
    raise SystemExit("Usage: python overlink_exchange.py prepare|verify PEER")
mode,peer=sys.argv[1:]
if peer not in ("NB","ALEX"):raise SystemExit("Unknown peer")
if mode=="prepare":
    data=os.urandom(2048)
    h=hashlib.sha256(data).hexdigest()
    envelope={"id":h,"kind":"file","filename":"transfer-proof.bin","content":base64.b64encode(data).decode("ascii"),"title":"Overlink synthetic two-PC test","from":peer}
    (folder/"outgoing.json").write_text(json.dumps(envelope),encoding="utf-8")
    print(json.dumps({"peer":peer,"bytes":len(data),"sha256":h,"artifact":"outgoing.json"}))
elif mode=="verify":
    envelope=json.loads((folder/f"incoming-{peer.lower()}.json").read_text(encoding="utf-8"))
    h=envelope["id"]
    expected=hashlib.sha256(base64.b64decode(envelope["content"])).hexdigest()
    target=folder/"target"/"Overlink"/"received"/(h[:16]+"-"+envelope["filename"])
    actual=hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
    if actual!=expected or expected!=h:raise SystemExit("Transferred file digest mismatch")
    print(json.dumps({"verified":True,"sent_by":peer,"bytes":target.stat().st_size,"sha256":actual}))
else:raise SystemExit("Unknown mode")
