#!/usr/bin/env python3
"""
Sanitize a Bitwarden export (plaintext .json or .csv) for use as test data.

Everything secret or identifying is replaced with fake values, but the *shape*
of the data is preserved so tests cover the same scenarios:
  - item kinds, which fields are present, folder nesting, collections/org items
  - URI structure (scheme, number of host labels, port, path presence, match type)
  - TOTP format (otpauth:// URI with its params, bare base32, steam://)
  - custom field types, password length and character classes, note length
  - favorites, reprompt, trash (deletedDate), passkeys, attachments

Nothing is sent anywhere. Standard library only. Run it yourself:

    python3 -I scripts/sanitize-bitwarden.py <export-dir> <output-dir>

Then open the output folder and check it before sharing it. The summary printed
at the end contains counts and field names only.
"""
import csv
import hashlib
import io
import json
import os
import random
import re
import sys
from collections import Counter, defaultdict
from urllib.parse import urlsplit

TEST_TOTP_SECRET = "JBSWY3DPEHPK3PXP"  # the well-known RFC test secret ("Hello!")
LOREM = ("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod "
         "tempor incididunt ut labore et dolore magna aliqua").split()
CJK = re.compile(r"[一-鿿぀-ヿ가-힯]")

rng = random.Random(42)


class Mapper:
    """Consistent fake values: the same real value always maps to the same fake one."""

    def __init__(self):
        self.maps = defaultdict(dict)
        self.counters = Counter()

    def get(self, kind, real, make):
        if real is None or real == "":
            return real
        table = self.maps[kind]
        if real not in table:
            self.counters[kind] += 1
            table[real] = make(self.counters[kind])
        return table[real]


M = Mapper()
summary = defaultdict(Counter)


def note(section, key, n=1):
    summary[section][key] += n


# ---------- value sanitizers ----------------------------------------------------

def fake_title(real, kind):
    def make(n):
        if CJK.search(real or ""):
            return f"条目 {n}"
        return f"{kind.capitalize()} item {n}"
    return M.get("title", real, make)


def fake_username(real):
    def make(n):
        if "@" in real:
            return f"user{n}@example.com"
        if real.isdigit():
            return str(13800000000 + n)  # phone-number shaped
        return f"user{n}"
    return M.get("username", real, make)


def fake_password(real):
    """Same length and character classes, random content."""
    if not real:
        return real
    classes = []
    if re.search(r"[a-z]", real): classes.append("abcdefghijkmnpqrstuvwxyz")
    if re.search(r"[A-Z]", real): classes.append("ABCDEFGHJKLMNPQRSTUVWXYZ")
    if re.search(r"[0-9]", real): classes.append("23456789")
    if re.search(r"[^A-Za-z0-9]", real): classes.append("!@#$%^&*()-_=+[]{};:,.?/")
    if not classes:
        classes = ["abcdefghijkmnpqrstuvwxyz"]
    note("password", f"len>={(len(real)//8)*8}")
    note("password", "classes=" + "".join(c[0] for c in classes))
    out = [rng.choice(c) for c in classes]
    while len(out) < len(real):
        out.append(rng.choice(rng.choice(classes)))
    rng.shuffle(out)
    return "".join(out[: len(real)])


def fake_text(real, label="notes"):
    """Lorem of similar length; keeps line structure."""
    if not real:
        return real
    note(label, f"len_bucket={min(len(real)//100*100, 2000)}")
    lines = real.split("\n")
    out = []
    for line in lines:
        words = max(1, len(line.split())) if line.strip() else 0
        out.append(" ".join(rng.choice(LOREM) for _ in range(words)))
    if CJK.search(real):
        out[0] = "示例备注 " + out[0]
    return "\n".join(out)


SECOND_LEVEL = {"co", "com", "net", "org", "gov", "edu", "ac"}


def fake_host(real_host):
    """Keeps the registrable domain consistent so sub.a.com and a.com stay related."""
    if re.fullmatch(r"[0-9.]+|\[?[0-9a-f:]+\]?", real_host.lower()):
        note("uri", "ip_host")
        return M.get("ip", real_host, lambda n: f"10.0.0.{n}")
    labels = real_host.lower().split(".")
    n_base = 3 if len(labels) >= 3 and labels[-2] in SECOND_LEVEL else 2
    base, subs = labels[-n_base:], labels[:-n_base]
    fake_base = M.get("domain", ".".join(base), lambda n: f"site{n}.example")
    fake_subs = [M.get("sub", s, lambda n: f"sub{n}") for s in subs]
    return ".".join(fake_subs + [fake_base])


def fake_uri(real):
    if not real:
        return real
    s = real.strip()
    parts = urlsplit(s if "://" in s else "https://" + s)
    scheme = parts.scheme if "://" in s else ""
    note("uri", f"scheme={scheme or '(none)'}")
    if scheme in ("androidapp", "iosapp"):
        pkg = M.get("pkg", parts.netloc or parts.path, lambda n: f"com.example.app{n}")
        return f"{scheme}://{pkg}"
    host = parts.hostname or ""
    if not host:
        note("uri", "unparseable")
        return "https://unparseable.example"
    fh = fake_host(host)
    if parts.port:
        fh += f":{parts.port}"
        note("uri", "has_port")
    if parts.username:
        note("uri", "has_userinfo")
    path = ""
    if parts.path and parts.path not in ("", "/"):
        depth = len([p for p in parts.path.split("/") if p])
        path = "/" + "/".join(f"p{i+1}" for i in range(depth))
        note("uri", f"path_depth={depth}")
    if parts.query:
        note("uri", "has_query")
        path += "?q=1"
    if parts.fragment:
        note("uri", "has_fragment")
    prefix = f"{scheme}://" if scheme else ""
    return f"{prefix}{fh}{path}"


def fake_totp(real):
    if not real:
        return real
    s = real.strip()
    if s.lower().startswith("steam://"):
        note("totp", "steam")
        return "steam://" + TEST_TOTP_SECRET
    if s.lower().startswith("otpauth://"):
        parts = urlsplit(s)
        params = dict(p.split("=", 1) for p in parts.query.split("&") if "=" in p)
        keep = {k: v for k, v in params.items() if k.lower() in ("algorithm", "digits", "period")}
        note("totp", "otpauth " + ",".join(f"{k}={v}" for k, v in sorted(keep.items())) or "otpauth")
        q = "&".join([f"secret={TEST_TOTP_SECRET}"] + [f"{k}={v}" for k, v in keep.items()])
        label = "Example:user@example.com"
        return f"otpauth://totp/{label}?{q}"
    note("totp", "bare_base32" if re.fullmatch(r"[A-Za-z2-7 =]+", s) else "unknown_format")
    return TEST_TOTP_SECRET


def fake_field(f):
    t = f.get("type", 0)
    note("fields", f"type={t}")
    name = M.get("fieldname", f.get("name") or "", lambda n: f"Field {n}")
    val = f.get("value")
    if t == 2:  # boolean
        val = val if val in ("true", "false") else "false"
    elif t == 3:  # linked
        pass
    elif val:
        val = fake_password(val) if t == 1 else fake_text(val, "fieldvalue").replace("\n", " ")
    out = dict(f)
    out["name"] = name
    out["value"] = val
    return out


CARD_NUMBERS = {"visa": "4111111111111111", "mastercard": "5555555555554444",
                "amex": "378282246310005", "unionpay": "6200000000000005"}


def fake_card(c):
    out = {}
    for k, v in c.items():
        if v in (None, ""):
            out[k] = v
            continue
        note("card_fields", k)
        if k == "cardholderName":
            out[k] = "Test Holder"
        elif k == "number":
            brand = (c.get("brand") or "visa").lower().replace(" ", "")
            out[k] = CARD_NUMBERS.get(brand, "4111111111111111")
        elif k == "code":
            out[k] = "123"
        else:
            out[k] = v  # brand, expMonth, expYear are not sensitive
    return out


def fake_identity(i):
    out = {}
    for k, v in i.items():
        if v in (None, ""):
            out[k] = v
            continue
        note("identity_fields", k)
        if k in ("email",):
            out[k] = fake_username(v if "@" in v else v + "@x")
        elif k in ("phone",):
            out[k] = "13800000000"
        elif k in ("ssn", "passportNumber", "licenseNumber"):
            out[k] = "TEST" + str(1000 + M.counters["idnum"])
            M.counters["idnum"] += 1
        elif k in ("username",):
            out[k] = fake_username(v)
        elif k in ("title",):
            out[k] = v
        else:
            out[k] = f"Sample {k}"
    return out


# ---------- item / folder --------------------------------------------------------

KINDS = {1: "login", 2: "note", 3: "card", 4: "identity", 5: "sshkey"}


def fake_folder_name(name):
    # Bitwarden nests folders with "/" in the name
    parts = name.split("/")
    note("folders", f"depth={len(parts)}")
    return "/".join(M.get("folder", p.strip(), lambda n: f"Folder {n}") for p in parts)


def sanitize_item(it):
    kind = KINDS.get(it.get("type"), f"type{it.get('type')}")
    note("items", kind)
    out = {}
    for k, v in it.items():
        if k == "name":
            out[k] = fake_title(v, kind)
        elif k == "notes":
            out[k] = fake_text(v)
        elif k == "fields" and v:
            out[k] = [fake_field(f) for f in v]
        elif k == "login" and v:
            lg = {}
            for lk, lv in v.items():
                if lk == "uris" and lv:
                    lg[lk] = [{**u, "uri": fake_uri(u.get("uri"))} for u in lv]
                    for u in lv:
                        note("uri_match", str(u.get("match")))
                    note("uri_count", str(min(len(lv), 5)))
                elif lk == "username":
                    lg[lk] = fake_username(lv)
                elif lk == "password":
                    lg[lk] = fake_password(lv)
                elif lk == "totp":
                    lg[lk] = fake_totp(lv)
                elif lk == "fido2Credentials" and lv:
                    note("features", "passkeys", len(lv))
                    lg[lk] = [{**c, "keyValue": "REDACTED", "userHandle": "REDACTED",
                               "userName": "user@example.com", "userDisplayName": "User",
                               "rpId": fake_host(c.get("rpId") or "example.com"),
                               "credentialId": "00000000-0000-0000-0000-000000000000"} for c in lv]
                elif lk == "passwordRevisionDate":
                    lg[lk] = lv
                    note("features", "passwordRevisionDate")
                else:
                    lg[lk] = lv
            out[k] = lg
        elif k == "card" and v:
            out[k] = fake_card(v)
        elif k == "identity" and v:
            out[k] = fake_identity(v)
        elif k == "sshKey" and v:
            note("features", "sshKey")
            out[k] = {kk: "REDACTED" for kk in v}
        elif k == "passwordHistory" and v:
            note("features", "passwordHistory")
            out[k] = [{**h, "password": fake_password(h.get("password", ""))} for h in v]
        elif k == "attachments" and v:
            note("features", "attachments", len(v))
            out[k] = [{**a, "fileName": f"file{i}.bin"} for i, a in enumerate(v)]
        else:
            if k == "favorite" and v: note("features", "favorite")
            if k == "reprompt" and v: note("features", "reprompt")
            if k == "deletedDate" and v: note("features", "in_trash")
            if k == "organizationId" and v: note("features", "org_item")
            if k == "collectionIds" and v: note("features", "collections")
            if k == "folderId" and v: note("features", "in_folder")
            if k == "key" and v: note("features", "encrypted_item_key")
            out[k] = v
    return out


def sanitize_json(doc):
    if doc.get("encrypted"):
        raise SystemExit("This export is encrypted. Export a plaintext .json temporarily, "
                         "sanitize it, then delete the plaintext file.")
    out = dict(doc)
    if doc.get("folders"):
        out["folders"] = [{**f, "name": fake_folder_name(f["name"])} for f in doc["folders"]]
    if doc.get("collections"):
        note("features", "collections_list", len(doc["collections"]))
        out["collections"] = [{**c, "name": M.get("coll", c["name"], lambda n: f"Collection {n}")}
                              for c in doc["collections"]]
    out["items"] = [sanitize_item(i) for i in doc.get("items", [])]
    return out


def sanitize_csv(text):
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for r in reader:
        kind = r.get("type", "login")
        note("items", f"csv:{kind}")
        row = dict(r)
        if row.get("folder"): row["folder"] = fake_folder_name(row["folder"])
        if row.get("name"): row["name"] = fake_title(row["name"], kind)
        if row.get("notes"): row["notes"] = fake_text(row["notes"])
        if row.get("fields"):
            lines = []
            for line in row["fields"].split("\n"):
                if ":" in line:
                    n, v = line.split(":", 1)
                    lines.append(f"{M.get('fieldname', n.strip(), lambda k: f'Field {k}')}: {fake_text(v.strip(), 'fieldvalue')}")
            row["fields"] = "\n".join(lines)
        if row.get("login_uri"):
            row["login_uri"] = ",".join(fake_uri(u) for u in row["login_uri"].split(","))
        if row.get("login_username"): row["login_username"] = fake_username(row["login_username"])
        if row.get("login_password"): row["login_password"] = fake_password(row["login_password"])
        if row.get("login_totp"): row["login_totp"] = fake_totp(row["login_totp"])
        rows.append(row)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=reader.fieldnames)
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]
    os.makedirs(dst, exist_ok=True)
    handled = 0
    for name in sorted(os.listdir(src)):
        path = os.path.join(src, name)
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(name)[1].lower()
        with open(path, "rb") as f:
            head = f.read(4096)
        if ext == ".json" or head.lstrip().startswith(b"{"):
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
            out = sanitize_json(doc)
            outname = f"export{handled+1}.json"
            with open(os.path.join(dst, outname), "w", encoding="utf-8") as f:
                json.dump(out, f, ensure_ascii=False, indent=2)
        elif ext == ".csv" or head.startswith(b"folder,favorite"):
            with open(path, encoding="utf-8-sig") as f:
                text = f.read()
            outname = f"export{handled+1}.csv"
            with open(os.path.join(dst, outname), "w", encoding="utf-8") as f:
                f.write(sanitize_csv(text))
        else:
            note("skipped_files", ext or "(no extension)")
            continue
        handled += 1
        print(f"sanitized -> {os.path.join(dst, outname)}")

    print("\n=== structure summary (counts only) ===")
    for section in sorted(summary):
        print(f"[{section}]")
        for k, v in sorted(summary[section].items()):
            print(f"  {k}: {v}")
    if handled == 0:
        print("No .json or .csv export found in", src)


if __name__ == "__main__":
    main()
