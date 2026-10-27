/* "Clean Your pdf" tab: removes the QR images and the rotated name stamp from a PDF, on this device.
   It is a port of the original script: square images of a set size are taken off every page
   (their drawing calls and their resources), and the rotated "q ... 0 1 -1 0 ... Q" blocks that
   contain the stamp characters are dropped. Nothing is uploaded. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  if (!$("clFile") || !window.PDFLib) return;
  var L = window.PDFLib, N = function (n) { return L.PDFName.of(n); };

  var S = { busy: false, cancel: false, file: null, out: null, outName: "clean.pdf", saving: false };
  var el = {};
  ["clFile", "clInfo", "clQr", "clName", "clMin", "clMax", "clChars", "clRun", "clProgCard", "clBarFill", "clProg", "clCancel", "clResult", "clSummary", "clSave", "clStatus"].forEach(function (id) { el[id] = $(id); });

  function setStatus(msg, kind) { el.clStatus.textContent = msg || ""; el.clStatus.className = "qr-status" + (kind ? " " + kind : ""); }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function bytesToLatin1(u8) { var out = [], CH = 8192; for (var i = 0; i < u8.length; i += CH) out.push(String.fromCharCode.apply(null, u8.subarray(i, i + CH))); return out.join(""); }
  function latin1ToBytes(s) { var u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; }
  function esc(t) { return t.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); }

  /* ---- the two cleaning rules (same logic as the original script) ---- */
  function removeNameBlocks(data, chars) {
    var lines = data.split("\n"), out = [], i = 0, removed = 0;
    while (i < lines.length) {
      if (lines[i].trim() === "q" && i + 1 < lines.length && lines[i + 1].indexOf("0 1 -1 0") >= 0) {
        var end = -1;
        for (var j = i + 1; j < Math.min(i + 15, lines.length); j++) if (lines[j].trim() === "Q") { end = j; break; }
        if (end >= 0) {
          var block = lines.slice(i, end + 1).join("\n"), hit = false;
          for (var k = 0; k < chars.length; k++) if (block.indexOf(chars[k]) >= 0) { hit = true; break; }
          if (hit) { i = end + 1; removed++; continue; }
        }
      }
      out.push(lines[i]); i++;
    }
    return { text: out.join("\n"), removed: removed };
  }
  function removeDoCalls(data, names) {
    var calls = 0;
    names.forEach(function (n) {
      data = data.replace(new RegExp(esc(n) + "\\s+Do\\b", "g"), function () { calls++; return ""; });
    });
    return { text: data, calls: calls };
  }

  function num(obj) { return obj instanceof L.PDFNumber ? obj.asNumber() : NaN; }

  /* drop every object that is no longer reachable (what qpdf does on save), so the removed images really leave the file */
  function collectGarbage(doc) {
    var ctx = doc.context, seen = new Set(), stack = [];
    function push(o) {
      if (o instanceof L.PDFRef) { if (seen.has(o.tag)) return; seen.add(o.tag); stack.push(ctx.lookup(o)); }
      else if (o) stack.push(o);
    }
    var ti = ctx.trailerInfo; push(ti.Root); push(ti.Info); push(ti.Encrypt);
    while (stack.length) {
      var o = stack.pop();
      if (o instanceof L.PDFDict) o.entries().forEach(function (kv) { push(kv[1]); });
      else if (o instanceof L.PDFArray) for (var i = 0; i < o.size(); i++) push(o.get(i));
      else if (o instanceof L.PDFRawStream) o.dict.entries().forEach(function (kv) { push(kv[1]); });
    }
    var dropped = 0;
    ctx.enumerateIndirectObjects().forEach(function (pair) { if (!seen.has(pair[0].tag)) { ctx.delete(pair[0]); dropped++; } });
    return dropped;
  }

  async function clean(file) {
    S.out = null; el.clResult.hidden = true;                  /* never leave an older result visible next to a new message */
    var minS = Math.max(1, parseInt(el.clMin.value, 10) || 250), maxS = Math.max(minS, parseInt(el.clMax.value, 10) || 300);
    var chars = (el.clChars.value || "").split(""), doQr = el.clQr.checked, doName = el.clName.checked;
    if (!doQr && !doName) { setStatus("اختر ما تريد حذفه أولًا.", "err"); return; }
    if (doName && !chars.length) { setStatus("اكتب حروف الاسم المائل أو أوقف خيار حذفه.", "err"); return; }
    S.busy = true; S.cancel = false; S.out = null; el.clResult.hidden = true; setBusy(true);
    setStatus("جارٍ فتح الملف…"); el.clBarFill.style.width = "0%"; el.clProg.textContent = "Opening PDF…";
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var doc = await L.PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
      if (doc.isEncrypted) throw new Error("ENCRYPTED");
      var ctx = doc.context, pages = doc.getPages(), total = pages.length;
      var dicts = new Map(), nameBlocks = 0, doCalls = 0, changedStreams = 0, t0 = Date.now(), done = 0;
      for (var p = 0; p < total; p++) {
        if (S.cancel) break;
        el.clBarFill.style.width = Math.round(p / total * 100) + "%";
        el.clProg.textContent = "Page " + (p + 1) + " of " + total + " \u00B7 " + Math.round((Date.now() - t0) / 1000) + " s";
        var node = pages[p].node, qrNames = [];
        /* square images of the chosen size, found in this page's resources */
        var res = node.Resources(), xo = res ? res.lookup(N("XObject")) : null;
        if (doQr && xo instanceof L.PDFDict) {
          xo.entries().forEach(function (kv) {
            var obj = ctx.lookup(kv[1]);
            if (!(obj instanceof L.PDFRawStream)) return;
            var sub = obj.dict.lookup(N("Subtype"));
            if (!(sub instanceof L.PDFName) || sub.asString() !== "/Image") return;
            var w = num(obj.dict.lookup(N("Width"))), h = num(obj.dict.lookup(N("Height")));
            if (w === h && w >= minS && w <= maxS) {
              qrNames.push(kv[0].asString());
              if (!dicts.has(xo)) dicts.set(xo, new Map());
              dicts.get(xo).set(kv[0], true);
            }
          });
        }
        /* the page's content streams */
        var c = node.get(N("Contents")), refs = [];
        if (c instanceof L.PDFRef) { var cobj = ctx.lookup(c); if (cobj instanceof L.PDFArray) { for (var a = 0; a < cobj.size(); a++) refs.push(cobj.get(a)); } else refs.push(c); }
        else if (c instanceof L.PDFArray) for (var b = 0; b < c.size(); b++) refs.push(c.get(b));
        for (var r = 0; r < refs.length; r++) {
          var ref = refs[r], st = ctx.lookup(ref);
          if (!(ref instanceof L.PDFRef) || !(st instanceof L.PDFRawStream)) continue;
          var original;
          try { original = L.decodePDFRawStream(st).decode(); } catch (e) { continue; }
          var text = bytesToLatin1(original), before = text;
          if (doName) { var rn = removeNameBlocks(text, chars); text = rn.text; nameBlocks += rn.removed; }
          if (qrNames.length) { var rd = removeDoCalls(text, qrNames); text = rd.text; doCalls += rd.calls; }
          if (text !== before) {
            var ns = ctx.flateStream(latin1ToBytes(text));
            st.dict.entries().forEach(function (kv) { var k = kv[0].asString(); if (k !== "/Filter" && k !== "/DecodeParms" && k !== "/Length") ns.dict.set(kv[0], kv[1]); });
            ctx.assign(ref, ns); changedStreams++;
          }
        }
        done = p + 1;
        if (p % 4 === 3) await tick();
      }
      if (S.cancel) { setStatus("أُلغي التنظيف. لم يتغير شيء.", "err"); return; }
      /* remove the image resources after every page that uses them has lost its drawing calls */
      var qrImages = 0;
      dicts.forEach(function (names, dict) { names.forEach(function (_, name) { if (dict.has(name)) { dict.delete(name); qrImages++; } }); });
      if (!nameBlocks && !qrImages) {
        el.clBarFill.style.width = "100%"; setStatus("لم يُعثر على اسم مائل أو صور QR مطابقة. الملف لم يتغير.", "err"); return;
      }
      el.clProg.textContent = "Saving…"; await tick();
      var dropped = 0; try { dropped = collectGarbage(doc); } catch (e) { dropped = 0; }
      var out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
      S.out = out; S.outName = (file.name.replace(/\.pdf$/i, "") || "book") + " - clean.pdf";
      el.clBarFill.style.width = "100%";
      el.clSummary.textContent = "";
      [["Pages", total], ["Rotated name blocks removed", nameBlocks], ["QR images removed", qrImages + (doCalls > qrImages ? " (" + doCalls + " places)" : "")], ["Size", fmtSize(file.size) + " \u2192 " + fmtSize(out.length)]].forEach(function (kv) {
        var row = document.createElement("div"); row.className = "cl-row"; var a1 = document.createElement("span"); a1.textContent = kv[0]; var b1 = document.createElement("b"); b1.textContent = kv[1];
        row.appendChild(a1); row.appendChild(b1); el.clSummary.appendChild(row);
      });
      el.clResult.hidden = false;
      setStatus("تم التنظيف. احفظ الملف بزر Save PDF.", "ok");
    } catch (e) {
      var m = String(e && e.message || e);
      setStatus(m === "ENCRYPTED" ? "الملف مشفّر أو محمي بكلمة مرور، لا يمكن تنظيفه." : "تعذّر تنظيف الملف: " + m, "err");
    } finally { setBusy(false); }
  }

  /* the size fields only matter for the QR option, the characters only for the name option */
  function setBusy(on) {
    S.busy = on; el.clProgCard.hidden = !on;
    el.clFile.disabled = on; el.clRun.disabled = on || !S.file; el.clQr.disabled = on; el.clName.disabled = on;
    el.clMin.disabled = on || !el.clQr.checked; el.clMax.disabled = on || !el.clQr.checked; el.clChars.disabled = on || !el.clName.checked;
  }

  async function save() {
    if (!S.out || S.saving || (window.WMNative && WMNative.isSaving())) return;
    S.saving = true; el.clSave.disabled = true; setStatus("جارٍ الحفظ…");
    try {
      var r = await WMNative.saveParts([S.out], S.outName, "application/pdf");
      if (r.ok) setStatus("تم حفظ " + S.outName, "ok"); else if (r.cancelled) setStatus("أُلغي الحفظ.", "err"); else setStatus("تعذّر الحفظ: " + r.error, "err");
    } finally { S.saving = false; el.clSave.disabled = false; }
  }

  el.clFile.addEventListener("change", function () {
    var f = el.clFile.files && el.clFile.files[0]; if (!f) return;
    S.file = f; el.clInfo.textContent = f.name + " (" + fmtSize(f.size) + ")"; el.clFile.value = ""; clean(f);
  });
  el.clQr.addEventListener("change", function () { setBusy(S.busy); });
  el.clName.addEventListener("change", function () { setBusy(S.busy); });
  el.clRun.addEventListener("click", function () { if (S.file && !S.busy) clean(S.file); });
  el.clCancel.addEventListener("click", function () { if (S.busy) { S.cancel = true; setStatus("جارٍ الإلغاء…"); } });
  el.clSave.addEventListener("click", save);
  window.WMClean = { state: S, run: clean };
  setBusy(false);
})();
