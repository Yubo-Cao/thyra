/**
 * The login and passkey-enrollment pages: small server-rendered documents
 * that load none of the application bundle. Their one script is served from
 * `AUTH_SCRIPT_PATH` (no inline code, so a strict `script-src 'self'` policy
 * allows it); the page's strings travel in a JSON data block.
 */

export const AUTH_SCRIPT_PATH = "/auth/passkey.js";

export type PageLocale = "en" | "zh-CN";

const STRINGS = {
  en: {
    loginTitle: "Log in to Thyra",
    loginHeading: "Log in",
    loginIntro: "Use a passkey saved on this device or your phone.",
    loginButton: "Log in with a passkey",
    loggingIn: "Waiting for your passkey...",
    loginNote:
      "Devices on the owner's tailnet log in automatically. Everyone else needs an enrollment link from the owner.",
    enrollTitle: "Set up a passkey",
    enrollHeading: "Set up a passkey",
    enrollFor: "Create a passkey for {name}.",
    enrollAdd: "Add a passkey to {name} for this site.",
    enrollButton: "Create passkey",
    enrolling: "Waiting for your passkey...",
    enrollDone: "Passkey saved. Opening Thyra...",
    enrollNote:
      "The passkey works on this site's address only. It stays on your device or password manager; Thyra stores only its public key.",
    enrollMissing:
      "This link is incomplete, expired or already used. Ask the owner for a new enrollment link.",
    insecure:
      "Passkeys need HTTPS (or localhost). Open Thyra through its HTTPS address.",
    unsupported: "This browser does not support passkeys.",
    cancelled: "The passkey request was cancelled or timed out. Try again.",
    unknownPasskey:
      "This passkey is not registered for this site. Use another passkey or ask the owner for an enrollment link.",
    disabled: "This account is disabled.",
    tooManyAttempts: "Too many attempts. Wait a few minutes and try again.",
    failed: "Unable to complete the request. Try again.",
    unreachable:
      "Cannot reach the server. Check your connection and try again.",
    noscript: "Enable JavaScript to use passkeys.",
    back: "Back to Thyra",
  },
  "zh-CN": {
    loginTitle: "登录 Thyra",
    loginHeading: "登录",
    loginIntro: "使用保存在本设备或手机上的通行密钥。",
    loginButton: "使用通行密钥登录",
    loggingIn: "正在等待通行密钥…",
    loginNote:
      "所有者 tailnet 中的设备会自动登录。其他用户需要所有者提供的注册链接。",
    enrollTitle: "设置通行密钥",
    enrollHeading: "设置通行密钥",
    enrollFor: "为 {name} 创建通行密钥。",
    enrollAdd: "为 {name} 在此站点添加通行密钥。",
    enrollButton: "创建通行密钥",
    enrolling: "正在等待通行密钥…",
    enrollDone: "通行密钥已保存，正在打开 Thyra…",
    enrollNote:
      "通行密钥仅适用于此站点地址。它保存在你的设备或密码管理器中；Thyra 只保存其公钥。",
    enrollMissing: "此链接不完整、已过期或已使用。请向所有者索取新的注册链接。",
    insecure:
      "通行密钥需要 HTTPS（或 localhost）。请通过 Thyra 的 HTTPS 地址打开。",
    unsupported: "此浏览器不支持通行密钥。",
    cancelled: "通行密钥请求已取消或超时，请重试。",
    unknownPasskey:
      "此通行密钥未在本站点注册。请换用其他通行密钥，或向所有者索取注册链接。",
    disabled: "此账户已停用。",
    tooManyAttempts: "尝试次数过多，请稍等几分钟后再试。",
    failed: "无法完成请求，请重试。",
    unreachable: "无法连接到服务器。请检查网络连接后重试。",
    noscript: "请启用 JavaScript 以使用通行密钥。",
    back: "返回 Thyra",
  },
} satisfies Record<PageLocale, Record<string, string>>;

type Strings = (typeof STRINGS)["en"];

/** Chinese when the highest-weighted Accept-Language entry is any zh variant. */
export function pageLocale(
  acceptLanguage: string | null | undefined,
): PageLocale {
  let best: { tag: string; q: number } | null = null;
  for (const entry of (acceptLanguage ?? "").split(",")) {
    const [rawTag, ...params] = entry.trim().split(";");
    const tag = rawTag?.trim() ?? "";
    if (!tag || tag === "*") continue;
    const qParam = params.find((param) => /^\s*q\s*=/i.test(param));
    const q = qParam ? Number(qParam.split("=")[1]) : 1;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (!best || q > best.q) best = { tag, q };
  }
  return best && /^zh\b/i.test(best.tag) ? "zh-CN" : "en";
}

/** A JSON data block that is safe inside a `<script>` element. */
function scriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const STYLE = `
  *{box-sizing:border-box}
  :root{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#eeeef0;
    background:#141516;color-scheme:dark;--panel:#1c1d1f;--muted:#a9abb0;--accent:#a8c5ff;
    --error:#ffaaaa;--button:#ececee;--button-text:#202124;--button-hover:#fff}
  body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:32px 20px}
  main{width:100%;max-width:400px}
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:24px;font-size:20px;font-weight:650;letter-spacing:-.5px}
  .brand img{width:36px;height:36px}
  .card{padding:32px;background:var(--panel)}
  h1{margin:0 0 8px;font-size:22px;font-weight:650;letter-spacing:-.5px}
  p{margin:0;color:var(--muted);font-size:14px;line-height:1.6}
  button{font:inherit;cursor:pointer}
  :focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .submit{width:100%;min-height:48px;padding:12px;margin-top:28px;border:0;border-radius:0;
    background:var(--button);color:var(--button-text);font-size:14px;font-weight:650}
  .submit:hover:not(:disabled){background:var(--button-hover)}
  .submit:disabled{opacity:.65;cursor:wait}
  .status{font-size:13px;line-height:1.5;min-height:24px;margin-top:12px}
  .status.error{color:var(--error)}
  .note{margin-top:24px;font-size:12px}
  a{color:var(--accent)}
  @media(prefers-color-scheme:light){
    :root{background:#f5f5f3;color:#252629;color-scheme:light;--panel:#fff;--muted:#64666d;
      --accent:#315fb4;--error:#b42332;--button:#292a2c;--button-text:#fff;--button-hover:#414245}
  }
  @media(max-width:380px){.card{padding:24px}body{padding:24px 16px}}
`;

/**
 * The login and enrollment logic, one static script for both pages. It reads
 * `{page, s}` from the `#thyra-auth` data block. Base64url and WebAuthn JSON
 * helpers cover browsers without `PublicKeyCredential.parse*OptionsFromJSON`
 * and `toJSON`.
 */
export const AUTH_SCRIPT = `(()=>{
const data=JSON.parse(document.getElementById('thyra-auth').textContent);
const S=data.s;
const b64=(buffer)=>{let s='';for(const b of new Uint8Array(buffer))s+=String.fromCharCode(b);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');};
const bytes=(text)=>{const s=atob(text.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((text.length+3)%4));return Uint8Array.from(s,c=>c.charCodeAt(0)).buffer;};
const PKC=window.PublicKeyCredential;
const creation=(o)=>PKC.parseCreationOptionsFromJSON?PKC.parseCreationOptionsFromJSON(o):{...o,challenge:bytes(o.challenge),user:{...o.user,id:bytes(o.user.id)},excludeCredentials:(o.excludeCredentials||[]).map(c=>({...c,id:bytes(c.id)}))};
const request=(o)=>PKC.parseRequestOptionsFromJSON?PKC.parseRequestOptionsFromJSON(o):{...o,challenge:bytes(o.challenge),allowCredentials:(o.allowCredentials||[]).map(c=>({...c,id:bytes(c.id)}))};
const toJSON=(c)=>{if(typeof c.toJSON==='function'){try{return c.toJSON();}catch{}}const r=c.response,out={id:c.id,rawId:b64(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults?c.getClientExtensionResults():{},authenticatorAttachment:c.authenticatorAttachment||undefined,response:{clientDataJSON:b64(r.clientDataJSON)}};
  if(r.attestationObject){out.response.attestationObject=b64(r.attestationObject);out.response.transports=r.getTransports?r.getTransports():[];}
  else{out.response.authenticatorData=b64(r.authenticatorData);out.response.signature=b64(r.signature);if(r.userHandle)out.response.userHandle=b64(r.userHandle);}
  return out;};
const post=async(url,body)=>{const r=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});let d={};try{d=await r.json();}catch{}return{status:r.status,ok:r.ok,data:d};};
const status=document.getElementById('status'),btn=document.getElementById('btn');
const show=(text,error)=>{status.textContent=text;status.className='status'+(error?' error':'');};
const errorFor=(r)=>r.status===429?S.tooManyAttempts:r.status===403?S.disabled:r.status===401?S.unknownPasskey:(r.data&&r.data.error)||S.failed;
const secure=window.isSecureContext&&!!PKC&&!!navigator.credentials;
if(!window.isSecureContext){show(S.insecure,true);btn.disabled=true;}
else if(!PKC){show(S.unsupported,true);btn.disabled=true;}
if(data.page==='login'){
  btn.onclick=async()=>{
    if(btn.disabled||!secure)return;
    btn.disabled=true;btn.textContent=S.loggingIn;show('',false);
    try{
      const start=await post('/api/auth/passkey/login/options',{});
      if(!start.ok){show(errorFor(start),true);return;}
      let credential;
      try{credential=await navigator.credentials.get({publicKey:request(start.data.options)});}
      catch{show(S.cancelled,true);return;}
      const done=await post('/api/auth/passkey/login/verify',{flow:start.data.flow,response:toJSON(credential)});
      if(done.ok){location.replace('/'+location.hash);return;}
      show(errorFor(done),true);
    }catch{show(S.unreachable,true);}
    finally{btn.disabled=!secure;btn.textContent=S.loginButton;}
  };
  return;
}
// The secret is in the fragment, which browsers never send to servers;
// drop it from the address bar and history at once.
const secret=location.hash.length>1?decodeURIComponent(location.hash.slice(1)):'';
if(secret)history.replaceState(null,'',location.pathname);
const intro=document.getElementById('intro');
let pending=null;
const load=async()=>{
  const r=await post('/api/auth/passkey/register/options',secret?{secret}:{});
  if(!r.ok){pending=null;intro.textContent='';show(r.status===401||r.status===404?S.enrollMissing:errorFor(r),true);btn.disabled=true;return false;}
  pending=r.data;
  const name=r.data.user.display_name===r.data.user.name?r.data.user.name:r.data.user.display_name+' ('+r.data.user.name+')';
  intro.textContent=(r.data.mode==='add'?S.enrollAdd:S.enrollFor).replace('{name}',name);
  btn.disabled=!secure;return true;
};
if(secure)load().catch(()=>show(S.unreachable,true));
btn.onclick=async()=>{
  if(btn.disabled||!pending)return;
  const current=pending;pending=null;
  btn.disabled=true;btn.textContent=S.enrolling;show('',false);
  let ok=false;
  try{
    let credential;
    try{credential=await navigator.credentials.create({publicKey:creation(current.options)});}
    catch{show(S.cancelled,true);await load();return;}
    const done=await post('/api/auth/passkey/register/verify',{flow:current.flow,response:toJSON(credential)});
    if(done.ok){ok=true;show(S.enrollDone,false);setTimeout(()=>location.replace('/'),600);return;}
    show(errorFor(done),true);await load();
  }catch{show(S.unreachable,true);}
  finally{if(!ok){btn.textContent=S.enrollButton;btn.disabled=!pending||!secure;}}
};
})();
`;

function page(
  locale: PageLocale,
  title: string,
  body: string,
  data: { page: "login" | "enroll"; s: Strings },
) {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<link rel="icon" type="image/svg+xml" href="/thyra-icon.svg">
<link rel="icon" type="image/png" href="/thyra-icon-192.png">
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="brand"><img src="/thyra-icon-192.png" alt="" width="36" height="36"><span>Thyra</span></div>
${body}
</main>
<script type="application/json" id="thyra-auth">${scriptValue(data)}</script>
<script src="${AUTH_SCRIPT_PATH}" defer></script>
</body>
</html>`;
}

export function renderLoginPage(locale: PageLocale): string {
  const s = STRINGS[locale];
  return page(
    locale,
    s.loginTitle,
    `  <section class="card" aria-labelledby="heading">
    <h1 id="heading">${s.loginHeading}</h1>
    <p>${s.loginIntro}</p>
    <button class="submit" id="btn" type="button">${s.loginButton}</button>
    <div class="status" id="status" role="alert" aria-live="polite"></div>
    <noscript><p class="status error">${s.noscript}</p></noscript>
    <p class="note">${s.loginNote}</p>
  </section>`,
    { page: "login", s },
  );
}

export function renderEnrollPage(locale: PageLocale): string {
  const s = STRINGS[locale];
  return page(
    locale,
    s.enrollTitle,
    `  <section class="card" aria-labelledby="heading">
    <h1 id="heading">${s.enrollHeading}</h1>
    <p id="intro"></p>
    <button class="submit" id="btn" type="button" disabled>${s.enrollButton}</button>
    <div class="status" id="status" role="alert" aria-live="polite"></div>
    <noscript><p class="status error">${s.noscript}</p></noscript>
    <p class="note">${s.enrollNote}</p>
    <p class="note"><a href="/">${s.back}</a></p>
  </section>`,
    { page: "enroll", s },
  );
}
