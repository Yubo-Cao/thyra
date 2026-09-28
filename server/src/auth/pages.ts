/**
 * The login, passkey-enrollment and share-link pages: small server-rendered
 * documents that load none of the application bundle. Their one script is
 * served from `AUTH_SCRIPT_PATH` (no inline code, so a strict
 * `script-src 'self'` policy allows it); the page's strings travel in a JSON
 * data block.
 */

import type { TailnetSsoLogin } from "./tailnet-sso";

export const AUTH_SCRIPT_PATH = "/auth/passkey.js";

export type PageLocale = "en" | "zh-CN";

const STRINGS = {
  en: {
    loginTitle: "Log in to Thyra",
    loginHeading: "Log in",
    loginIntro: "Use a passkey saved on this device or your phone.",
    loginButton: "Log in with a passkey",
    loggingIn: "Waiting for your passkey...",
    loginNote: "New here? Ask the owner for an invitation.",
    orDivider: "or",
    loginIntroMethods: "Choose how to sign in.",
    continueGoogle: "Continue with Google",
    continueGithub: "Continue with GitHub",
    emailLabel: "Email",
    emailSend: "Email me a code",
    emailSending: "Sending...",
    emailSent:
      "If {email} can receive email, a 6-digit code is on its way. Enter it here, or open the link in the email.",
    codeLabel: "6-digit code",
    codeButton: "Sign in",
    codeChecking: "Checking...",
    codeWrong: "That code is wrong or expired.",
    emailAgain: "Use another address",
    emailInvalid: "Enter a valid email address.",
    emailUnavailable: "The email could not be sent. Try again later.",
    emailLinkChecking: "Signing you in...",
    emailLinkMissing:
      "This link is incomplete, expired or already used. Request a new code.",
    unknownIdentity:
      "Signed in as {label} via {provider}. Ask the owner for access.",
    oauthRedirecting: "Opening {provider}...",
    oauthWaiting:
      "Finish signing in in the window that opened. If it asks, check that it shows {pairing}.",
    oauthFailed: "Sign-in did not complete. Try again.",
    resultTitle: "Thyra sign-in",
    doneHeading: "Signed in",
    doneClose: "You can close this window and return to Thyra.",
    linkedHeading: "Sign-in method added",
    errorHeading: "Sign-in did not complete",
    unknownHeading: "No access yet",
    err_expired: "This sign-in expired or was already used. Start again.",
    err_cancelled: "Sign-in was cancelled.",
    err_provider: "The provider did not complete the sign-in. Try again.",
    err_linked_elsewhere:
      "This account is already linked to another Thyra account.",
    err_disabled: "This account is disabled.",
    confirmTitle: "Finish signing in?",
    confirmIntro:
      "{provider} confirmed you as {label}. Thyra will sign in the app or window where you started, which shows this number:",
    confirmLinkIntro:
      "{provider} confirmed you as {label}. Thyra will add it to the account that started this, whose window shows this number:",
    confirmWarning:
      "Continue only if you started this yourself and the numbers match.",
    confirmButton: "Yes, finish",
    cancelButton: "Cancel",
    confirmDone:
      "Done. Return to Thyra where you started; it continues on its own.",
    confirmCancelled: "Cancelled. Nothing was signed in.",
    inviteTitle: "Join Thyra",
    inviteHeading: "You're invited",
    inviteIntro: "You're invited as {name} ({email}). Choose how to sign in.",
    inviteAccept: "Continue as {email}",
    inviteMissing:
      "This invitation is incomplete, expired or already used. Ask for a new one.",
    backToLogin: "Back to log in",
    deviceChecking: "Checking this device...",
    tailnetButton: "Sign in with tailnet",
    tailnetHint:
      "Only for devices on the owner's tailnet: it opens {host}, which does not load anywhere else.",
    tailnet_unavailable:
      "This device is not on the owner's tailnet. Log in with a passkey instead.",
    tailnet_failed: "Tailnet sign-in did not complete. Try again.",
    tailnet_expired: "Tailnet sign-in took too long. Try again.",
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
    shareTitle: "Shared Thyra workspace",
    shareHeading: "Watch a shared workspace",
    shareIntro:
      "You were given a read-only view of a Thyra workspace. You can watch its terminals and scroll their history; you cannot type or change anything.",
    shareButton: "Open shared view",
    sharing: "Opening...",
    shareNote:
      "No account needed. This browser keeps a cookie for the view until the link expires or its owner revokes it.",
    shareMissing:
      "This link is incomplete. Open the full link you were sent, including the part after #.",
    share_invalid: "This share link is not valid.",
    share_expired: "This share link has expired.",
    share_revoked: "This share link was revoked.",
    share_used: "This share link has been used the maximum number of times.",
    shareNoscript: "Enable JavaScript to open the shared view.",
    shareSignedIn:
      "You are signed in as {name}. Open Thyra with your account and its access, or watch through this link as an anonymous guest.",
    shareHostOwner: "the host owner",
    shareAccountButton: "Open with my account",
    shareGuestButton: "Open as guest",
    share_signed_in:
      "You are signed in. Choose Open as guest to watch through this link.",
    endedTitle: "Shared view ended",
    endedHeading: "Shared view ended",
    endedIntro:
      "The shared view you were watching has ended: its link expired or was revoked. Ask the person who shared it for a new link.",
  },
  "zh-CN": {
    loginTitle: "登录 Thyra",
    loginHeading: "登录",
    loginIntro: "使用保存在本设备或手机上的通行密钥。",
    loginButton: "使用通行密钥登录",
    loggingIn: "正在等待通行密钥…",
    loginNote: "还没有账户？请向所有者索取邀请。",
    orDivider: "或",
    loginIntroMethods: "选择登录方式。",
    continueGoogle: "使用 Google 继续",
    continueGithub: "使用 GitHub 继续",
    emailLabel: "邮箱",
    emailSend: "发送验证码",
    emailSending: "正在发送…",
    emailSent:
      "如果 {email} 能收到邮件，6 位验证码已发出。请在此输入，或打开邮件中的链接。",
    codeLabel: "6 位验证码",
    codeButton: "登录",
    codeChecking: "正在验证…",
    codeWrong: "验证码错误或已过期。",
    emailAgain: "换一个邮箱",
    emailInvalid: "请输入有效的邮箱地址。",
    emailUnavailable: "邮件发送失败，请稍后再试。",
    emailLinkChecking: "正在登录…",
    emailLinkMissing: "此链接不完整、已过期或已使用。请重新获取验证码。",
    unknownIdentity:
      "已通过 {provider} 以 {label} 的身份登录。请向所有者申请访问权限。",
    oauthRedirecting: "正在打开 {provider}…",
    oauthWaiting:
      "请在打开的窗口中完成登录。如被询问，请确认显示的数字为 {pairing}。",
    oauthFailed: "登录未完成，请重试。",
    resultTitle: "Thyra 登录",
    doneHeading: "已登录",
    doneClose: "可以关闭此窗口并返回 Thyra。",
    linkedHeading: "已添加登录方式",
    errorHeading: "登录未完成",
    unknownHeading: "尚无访问权限",
    err_expired: "此登录已过期或已使用。请重新开始。",
    err_cancelled: "登录已取消。",
    err_provider: "提供方未完成登录，请重试。",
    err_linked_elsewhere: "此账户已关联到另一个 Thyra 账户。",
    err_disabled: "此账户已停用。",
    confirmTitle: "完成登录？",
    confirmIntro:
      "{provider} 已确认你是 {label}。Thyra 将登录你开始操作的应用或窗口，那里显示的数字是：",
    confirmLinkIntro:
      "{provider} 已确认你是 {label}。Thyra 会把它添加到发起此操作的账户，其窗口显示的数字是：",
    confirmWarning: "仅当这是你本人发起且数字一致时才继续。",
    confirmButton: "是，继续",
    cancelButton: "取消",
    confirmDone: "完成。返回你开始操作的 Thyra，它会自动继续。",
    confirmCancelled: "已取消，未登录任何账户。",
    inviteTitle: "加入 Thyra",
    inviteHeading: "你收到了邀请",
    inviteIntro: "你以 {name}（{email}）的身份受邀。请选择登录方式。",
    inviteAccept: "以 {email} 继续",
    inviteMissing: "此邀请不完整、已过期或已使用。请索取新的邀请。",
    backToLogin: "返回登录",
    deviceChecking: "正在检查此设备…",
    tailnetButton: "通过 tailnet 登录",
    tailnetHint:
      "仅适用于所有者 tailnet 中的设备：它会打开 {host}，该地址在其他网络中无法加载。",
    tailnet_unavailable: "此设备不在所有者的 tailnet 中。请改用通行密钥登录。",
    tailnet_failed: "tailnet 登录未完成，请重试。",
    tailnet_expired: "tailnet 登录超时，请重试。",
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
    shareTitle: "共享的 Thyra 工作区",
    shareHeading: "观看共享的工作区",
    shareIntro:
      "你获得了一个 Thyra 工作区的只读视图。你可以观看其中的终端并滚动历史记录，但不能输入或更改任何内容。",
    shareButton: "打开共享视图",
    sharing: "正在打开…",
    shareNote:
      "无需账户。此浏览器会为该视图保留一个 Cookie，直到链接过期或被所有者撤销。",
    shareMissing: "此链接不完整。请打开收到的完整链接，包括 # 之后的部分。",
    share_invalid: "此共享链接无效。",
    share_expired: "此共享链接已过期。",
    share_revoked: "此共享链接已被撤销。",
    share_used: "此共享链接的使用次数已达上限。",
    shareNoscript: "请启用 JavaScript 以打开共享视图。",
    shareSignedIn:
      "你已以 {name} 的身份登录。可以用你的账户及其权限打开 Thyra，或通过此链接以匿名访客身份观看。",
    shareHostOwner: "主机所有者",
    shareAccountButton: "用我的账户打开",
    shareGuestButton: "以访客身份打开",
    share_signed_in: "你已登录。如需通过此链接观看，请选择“以访客身份打开”。",
    endedTitle: "共享视图已结束",
    endedHeading: "共享视图已结束",
    endedIntro:
      "你正在观看的共享视图已结束：其链接已过期或被撤销。请向分享者索取新的链接。",
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
    --error:#ffaaaa;--button:#ececee;--button-text:#202124;--button-hover:#fff;--line:#34363a}
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
  .secondary{width:100%;min-height:44px;padding:10px;margin-top:12px;border:1px solid var(--muted);
    border-radius:0;background:transparent;color:inherit;font-size:14px;font-weight:600}
  .secondary:disabled{opacity:.65;cursor:wait}
  a.secondary{display:flex;align-items:center;justify-content:center;text-decoration:none}
  [hidden]{display:none!important}
  .tailnet-hint{margin-top:8px}
  .divider{display:flex;align-items:center;gap:12px;margin:20px 0 4px;color:var(--muted);font-size:12px}
  .divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--line)}
  .field{display:block;margin-top:12px;font-size:12px;color:var(--muted)}
  .input{width:100%;min-height:44px;margin-top:6px;padding:10px 12px;border:1px solid var(--muted);border-radius:0;
    background:transparent;color:inherit;font:inherit;font-size:15px}
  .input.code{font-family:ui-monospace,Menlo,monospace;font-size:22px;letter-spacing:6px}
  .linkish{margin-top:10px;padding:0;border:0;background:none;color:var(--accent);font-size:13px}
  .pairing{margin:16px 0;font-family:ui-monospace,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:inherit}
  .account{margin-top:16px;color:inherit}
  .status{font-size:13px;line-height:1.5;min-height:24px;margin-top:12px}
  .status.error{color:var(--error)}
  .note{margin-top:24px;font-size:12px}
  a{color:var(--accent)}
  @media(prefers-color-scheme:light){
    :root{background:#f5f5f3;color:#252629;color-scheme:light;--panel:#fff;--muted:#64666d;
      --accent:#315fb4;--error:#b42332;--button:#292a2c;--button-text:#fff;--button-hover:#414245;--line:#dcdcd8}
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
if(data.page==='share'){
  // The link's secret is in the fragment, which browsers never send to
  // servers; keep it in memory only and post it when the visitor opens the
  // view (link previews never redeem a use).
  const secret=location.hash.length>1?decodeURIComponent(location.hash.slice(1)):'';
  if(secret)history.replaceState(null,'',location.pathname);
  const id=location.pathname.split('/')[2]||'';
  if(!secret){show(S.shareMissing,true);return;}
  const redeem=(button,label,asGuest)=>async()=>{
    if(button.disabled)return;
    button.disabled=true;button.textContent=S.sharing;show('',false);
    try{
      const r=await post('/api/share/redeem',asGuest?{id,secret,as_guest:true}:{id,secret});
      if(r.ok){location.replace('/');return;}
      show(r.status===429?S.tooManyAttempts:S['share_'+(r.data&&r.data.reason)]||S.share_invalid,true);
    }catch{show(S.unreachable,true);}
    button.disabled=false;button.textContent=label;
  };
  btn.disabled=false;
  if(data.account){
    // Signed in: keep the account and its access unless the visitor asks
    // to watch as an anonymous guest.
    document.getElementById('account').textContent=S.shareSignedIn.replace('{name}',data.account.name||S.shareHostOwner);
    btn.onclick=()=>location.replace('/');
    const guest=document.getElementById('guest');
    guest.disabled=false;
    guest.onclick=redeem(guest,S.shareGuestButton,true);
    return;
  }
  btn.onclick=redeem(btn,S.shareButton,false);
  return;
}
const fill=(text,values)=>text.replace(/\\{(\\w+)\\}/g,(m,k)=>values[k]!==undefined?values[k]:m);
const NAMES={google:'Google',github:'GitHub',email:S.emailLabel};
const $=(id)=>document.getElementById(id);
const home=()=>location.replace('/');
if(data.page==='result'){if(data.close)setTimeout(()=>{try{window.close();}catch{}},400);return;}
if(data.page==='email-link'){
  // The link's secret is in the fragment, never sent to servers or logs.
  const [flow,link]=(location.hash.slice(1)||'').split('.');
  history.replaceState(null,'',location.pathname);
  if(!flow||!link){show(S.emailLinkMissing,true);return;}
  show(S.emailLinkChecking,false);
  post('/auth/email/verify',{flow,link}).then((r)=>{
    if(r.ok&&r.data.status==='signed_in'){home();return;}
    if(r.ok&&r.data.status==='unknown'){show(fill(S.unknownIdentity,{label:r.data.label,provider:NAMES.email}),true);return;}
    show(r.status===429?S.tooManyAttempts:S.emailLinkMissing,true);
  }).catch(()=>show(S.unreachable,true));
  return;
}
if(data.page==='confirm'){
  const cancel=$('cancel');
  const answer=(accept)=>async()=>{
    btn.disabled=true;cancel.disabled=true;
    try{
      const r=await post('/auth/oauth/confirm',{flow:data.flow,confirm:data.confirm,accept});
      $('confirm-body').hidden=true;
      const st=r.data&&r.data.status;
      show(st==='done'?S.confirmDone:st==='cancelled'?S.confirmCancelled:st==='unknown'?fill(S.unknownIdentity,{label:r.data.label,provider:NAMES[data.provider]||data.provider}):S.oauthFailed,st!=='done'&&st!=='cancelled');
    }catch{show(S.unreachable,true);btn.disabled=false;cancel.disabled=false;}
  };
  btn.onclick=answer(true);cancel.onclick=answer(false);
  return;
}
// GitHub and Google. A Home Screen app keeps this page open and polls,
// since the provider may return in Safari; elsewhere it navigates.
const pollFlow=(flow,secret,done)=>{
  const started=Date.now();
  const tick=async()=>{
    let r=null;try{r=await post('/auth/oauth/poll',{flow,poll:secret});}catch{}
    const st=r&&r.data&&r.data.status;
    if(st==='done'){home();return;}
    if(st==='unknown'){done(fill(S.unknownIdentity,{label:r.data.label,provider:NAMES[r.data.provider]||''}));return;}
    if(st==='failed'||st==='expired'||Date.now()-started>600000){done(S.oauthFailed);return;}
    setTimeout(tick,1500);
  };
  setTimeout(tick,1500);
};
const startOAuth=(provider,button,extra)=>async()=>{
  if(button.disabled)return;
  button.disabled=true;show(fill(S.oauthRedirecting,{provider:NAMES[provider]}),false);
  const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  // Opened now, while the click still counts as a user gesture.
  const popup=standalone?window.open('about:blank','thyra-oauth'):null;
  try{
    const r=await post('/auth/oauth/'+provider+'/start',{intent:'login',popup:!!popup,...extra});
    if(!r.ok){if(popup)popup.close();show((r.data&&r.data.error)||S.oauthFailed,true);button.disabled=false;return;}
    if(!popup){location.assign(r.data.url);return;}
    popup.location.href=r.data.url;
    show(fill(S.oauthWaiting,{pairing:r.data.pairing}),false);
    pollFlow(r.data.flow,r.data.poll,(text)=>{show(text,true);button.disabled=false;});
  }catch{if(popup)popup.close();show(S.unreachable,true);button.disabled=false;}
};
const wireOAuth=(extra)=>{for(const button of document.querySelectorAll('[data-provider]'))button.onclick=startOAuth(button.dataset.provider,button,extra);};
if(data.page==='invite'){
  const token=location.hash.length>1?decodeURIComponent(location.hash.slice(1)):'';
  history.replaceState(null,'',location.pathname);
  const body=$('invite-body');
  if(!token){show(S.inviteMissing,true);return;}
  post('/auth/invite/check',{token}).then((r)=>{
    if(!r.ok){show(r.status===429?S.tooManyAttempts:S.inviteMissing,true);return;}
    $('intro').textContent=fill(S.inviteIntro,{name:r.data.name,email:r.data.email});
    btn.textContent=fill(S.inviteAccept,{email:r.data.email});
    body.hidden=false;
    wireOAuth({invite:token});
    btn.onclick=async()=>{
      if(btn.disabled)return;btn.disabled=true;
      try{const a=await post('/auth/invite/accept',{token});if(a.ok){home();return;}show(S.inviteMissing,true);}
      catch{show(S.unreachable,true);btn.disabled=false;}
    };
  }).catch(()=>show(S.unreachable,true));
  return;
}
const errorFor=(r)=>r.status===429?S.tooManyAttempts:r.status===403?S.disabled:r.status===401?S.unknownPasskey:(r.data&&r.data.error)||S.failed;
const secure=window.isSecureContext&&!!PKC&&!!navigator.credentials;
if(data.page==='login'){
  if(!window.isSecureContext){btn.disabled=true;}else if(!PKC){btn.disabled=true;}
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
  wireOAuth({});
  const emailForm=$('email-form'),codeForm=$('code-form');
  if(emailForm){
    let flow=null,address='';
    const send=$('email-send'),input=$('email'),code=$('code');
    emailForm.onsubmit=async(event)=>{
      event.preventDefault();
      address=input.value.trim();
      if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(address)){show(S.emailInvalid,true);input.focus();return;}
      send.disabled=true;send.textContent=S.emailSending;show('',false);
      try{
        const r=await post('/auth/email/start',{email:address});
        if(!r.ok){show(r.status===429?S.tooManyAttempts:r.status===400?S.emailInvalid:S.emailUnavailable,true);return;}
        flow=r.data.flow;
        emailForm.hidden=true;codeForm.hidden=false;
        $('code-intro').textContent=fill(S.emailSent,{email:address});
        code.value='';code.focus();
      }catch{show(S.unreachable,true);}
      finally{send.disabled=false;send.textContent=S.emailSend;}
    };
    codeForm.onsubmit=async(event)=>{
      event.preventDefault();
      const submit=$('code-submit');
      const value=code.value.replace(/\\D/g,'');
      if(value.length!==6){show(S.codeWrong,true);code.focus();return;}
      submit.disabled=true;submit.textContent=S.codeChecking;show('',false);
      try{
        const r=await post('/auth/email/verify',{flow,code:value});
        if(r.ok&&r.data.status==='signed_in'){location.replace('/'+location.hash);return;}
        if(r.ok&&r.data.status==='unknown'){show(fill(S.unknownIdentity,{label:r.data.label,provider:NAMES.email}),true);return;}
        show(r.status===429?S.tooManyAttempts:r.status===403?S.disabled:S.codeWrong,true);
      }catch{show(S.unreachable,true);}
      finally{submit.disabled=false;submit.textContent=S.codeButton;}
    };
    $('email-back').onclick=()=>{codeForm.hidden=true;emailForm.hidden=false;show('',false);input.focus();};
  }
  const choices=$('choices');
  const tailnet=data.tailnet;
  const reveal=()=>{if(!choices.hidden)return;show('',false);choices.hidden=false;};
  if(!tailnet){choices.hidden=false;return;}
  // The tailnet listener's address is not in this page; only the tailnet
  // code path asks for it.
  let where=null;
  const origin=()=>where??=fetch('/auth/tailnet-sso/config',{credentials:'same-origin',cache:'no-store'}).then(r=>r.ok?r.json():null).then(d=>d&&typeof d.url==='string'?d.url:null).catch(()=>null);
  // The "Sign in with tailnet" button appears only on evidence that this is
  // a tailnet device: an earlier tailnet sign-in in this browser, or Chrome's
  // Local Network Access question, which Chrome asks only after connecting
  // to the tailnet host (so blocking it proves the device reached it).
  const offer=async()=>{
    const url=await origin();
    if(!url||$('tailnet'))return;
    const hint=fill(S.tailnetHint,{host:new URL(url).host});
    const link=document.createElement('a');
    link.className='secondary';link.id='tailnet';link.href='/auth/tailnet-sso/start';link.title=hint;link.textContent=S.tailnetButton;
    const note=document.createElement('p');
    note.className='note tailnet-hint';note.textContent=hint;
    choices.append(link,note);
  };
  if(tailnet.known)void offer();
  const permission=async()=>{
    if(!navigator.permissions)return null;
    for(const name of ['local-network-access','local-network']){try{return await navigator.permissions.query({name});}catch{}}
    return null;
  };
  // Silent tailnet sign-in: ask the tailnet listener, which knows this
  // device by its Tailscale identity, for a single-use code bound to a PKCE
  // challenge, then redeem it here with the verifier. A device off the
  // tailnet cannot reach it; after a short wait the buttons appear.
  // Chrome's Local Network Access may ask first: the buttons appear anyway,
  // "allow" still signs in, and "block" offers the tailnet button.
  (async()=>{
    const access=await permission();
    const state=access?access.state:null;
    if(state==='denied')void offer();
    else if(state==='prompt')access.addEventListener('change',()=>{if(access.state==='denied')void offer();});
    if(!tailnet.silent){choices.hidden=false;return;}
    if(state==='denied'||!window.isSecureContext||!crypto.subtle){reveal();return;}
    try{
      const url=await origin();
      if(!url){reveal();return;}
      const verifier=b64(crypto.getRandomValues(new Uint8Array(32)));
      const challenge=b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
      const abort=new AbortController();
      const shown=setTimeout(reveal,1800);
      const timer=setTimeout(()=>abort.abort(),state==='prompt'?60000:1800);
      let r;
      try{r=await fetch(url+'/auth/tailnet-sso/code',{method:'POST',mode:'cors',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{'content-type':'application/json'},body:JSON.stringify({code_challenge:challenge}),signal:abort.signal});}
      finally{clearTimeout(timer);clearTimeout(shown);}
      if(r.ok){
        const issued=await r.json();
        const done=await post('/auth/tailnet-sso/redeem',{code:issued.code,code_verifier:verifier});
        if(done.ok){location.replace('/'+location.hash);return;}
      }
    }catch{}
    reveal();
  })();
  return;
}
if(!window.isSecureContext){show(S.insecure,true);btn.disabled=true;}
else if(!PKC){show(S.unsupported,true);btn.disabled=true;}
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
  data: {
    page:
      | "login"
      | "enroll"
      | "share"
      | "email-link"
      | "invite"
      | "confirm"
      | "result";
    s: Strings;
    account?: { name: string | null };
    tailnet?: { silent: boolean; known: boolean };
    flow?: string;
    confirm?: string;
    provider?: string;
    close?: boolean;
  } | null,
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
${
  data
    ? `<script type="application/json" id="thyra-auth">${scriptValue(data)}</script>
<script src="${AUTH_SCRIPT_PATH}" defer></script>
`
    : ""
}</body>
</html>`;
}

/**
 * The landing page of a share link, `/s/<id>#<secret>`. A visitor already
 * signed in (`account`; `name` null for direct local use) keeps its account
 * unless it chooses to open the link as a guest.
 */
export function renderSharePage(
  locale: PageLocale,
  account: { name: string | null } | null = null,
): string {
  const s = STRINGS[locale];
  return page(
    locale,
    s.shareTitle,
    `  <section class="card" aria-labelledby="heading">
    <h1 id="heading">${s.shareHeading}</h1>
    <p>${s.shareIntro}</p>
${account ? '    <p class="account" id="account"></p>\n' : ""}    <button class="submit" id="btn" type="button" disabled>${account ? s.shareAccountButton : s.shareButton}</button>
${account ? `    <button class="secondary" id="guest" type="button" disabled>${s.shareGuestButton}</button>\n` : ""}    <div class="status" id="status" role="alert" aria-live="polite"></div>
    <noscript><p class="status error">${s.shareNoscript}</p></noscript>
    <p class="note">${s.shareNote}</p>
  </section>`,
    { page: "share", s, ...(account ? { account } : {}) },
  );
}

/** Shown instead of the login page once a guest's shared view has ended. */
export function renderShareEndedPage(locale: PageLocale): string {
  const s = STRINGS[locale];
  return page(
    locale,
    s.endedTitle,
    `  <section class="card" aria-labelledby="heading">
    <h1 id="heading">${s.endedHeading}</h1>
    <p>${s.endedIntro}</p>
  </section>`,
    null,
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type LoginProviders = {
  email: boolean;
  github: boolean;
  google: boolean;
};

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  github: "GitHub",
};

/** "Continue with Google/GitHub" buttons for the configured providers. */
function oauthButtons(s: Strings, providers: LoginProviders): string {
  return [
    providers.google
      ? `    <button class="secondary" type="button" data-provider="google">${s.continueGoogle}</button>\n`
      : "",
    providers.github
      ? `    <button class="secondary" type="button" data-provider="github">${s.continueGithub}</button>\n`
      : "",
  ].join("");
}

/**
 * The login page: a passkey, then GitHub and Google (when configured), then
 * an emailed code (address, then the code; the mailed link works too). On
 * the public listener with tailnet sign-in (`tailnet`), the page first asks
 * the tailnet listener for a code without showing any button (`silent`),
 * and reveals the choices when that fails. The page names neither tailnet
 * nor its host: the script fetches the host for the silent attempt, and
 * adds a "Sign in with tailnet" redirect button only on a device that
 * signed in through the tailnet before (`known`) or that Chrome asked for
 * local network access.
 */
export function renderLoginPage(
  locale: PageLocale,
  tailnet: TailnetSsoLogin | null = null,
  providers: LoginProviders = { email: false, github: false, google: false },
): string {
  const s = STRINGS[locale];
  const message = tailnet?.message
    ? s[`tailnet_${tailnet.message}` as const]
    : "";
  const silent = Boolean(tailnet?.silent);
  const others = providers.email || providers.github || providers.google;
  return page(
    locale,
    s.loginTitle,
    `  <section class="card" aria-labelledby="heading">
    <h1 id="heading">${s.loginHeading}</h1>
    <p>${others ? s.loginIntroMethods : s.loginIntro}</p>
    <div id="choices"${silent ? " hidden" : ""}>
    <button class="submit" id="btn" type="button">${s.loginButton}</button>
${oauthButtons(s, providers)}${
  providers.email
    ? `    <div class="divider">${s.orDivider}</div>
    <form id="email-form" novalidate>
      <label class="field" for="email">${s.emailLabel}</label>
      <input class="input" id="email" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" required>
      <button class="secondary" id="email-send" type="submit">${s.emailSend}</button>
    </form>
    <form id="code-form" hidden novalidate>
      <p id="code-intro"></p>
      <label class="field" for="code">${s.codeLabel}</label>
      <input class="input code" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}">
      <button class="submit" id="code-submit" type="submit">${s.codeButton}</button>
      <button class="linkish" id="email-back" type="button">${s.emailAgain}</button>
    </form>
`
    : ""
}    </div>
    <div class="status${message ? " error" : ""}" id="status" role="alert" aria-live="polite">${silent ? s.deviceChecking : message}</div>
    <noscript><p class="status error">${s.noscript}</p></noscript>
    <p class="note">${s.loginNote}</p>
  </section>`,
    {
      page: "login",
      s,
      ...(tailnet ? { tailnet: { silent, known: tailnet.known } } : {}),
    },
  );
}

/** A mailed sign-in link's landing page, `/auth/email#<flow>.<secret>`. */
export function renderEmailLinkPage(locale: PageLocale): string {
  const s = STRINGS[locale];
  return page(
    locale,
    s.loginTitle,
    `  <section class="card" aria-labelledby="heading">
    <h1 id="heading">${s.loginHeading}</h1>
    <div class="status" id="status" role="alert" aria-live="polite">${s.emailLinkChecking}</div>
    <noscript><p class="status error">${s.noscript}</p></noscript>
    <p class="note"><a href="/login">${s.backToLogin}</a></p>
  </section>`,
    { page: "email-link", s },
  );
}

/** An invitation's landing page, `/invite#<token>`. */
export function renderInvitePage(
  locale: PageLocale,
  providers: LoginProviders,
): string {
  const s = STRINGS[locale];
  return page(
    locale,
    s.inviteTitle,
    `  <section class="card" aria-labelledby="heading">
    <h1 id="heading">${s.inviteHeading}</h1>
    <div id="invite-body" hidden>
    <p id="intro"></p>
    <button class="submit" id="btn" type="button">${s.inviteAccept}</button>
${oauthButtons(s, providers)}    </div>
    <div class="status" id="status" role="alert" aria-live="polite"></div>
    <noscript><p class="status error">${s.noscript}</p></noscript>
  </section>`,
    { page: "invite", s },
  );
}

/**
 * The provider returned to a browser that did not start the sign-in: show
 * who signed in and the pairing number, and ask before finishing.
 */
export function renderOAuthConfirmPage(
  locale: PageLocale,
  args: {
    flow: string;
    confirm: string;
    pairing: string;
    provider: string;
    label: string;
    intent: "login" | "link";
  },
): string {
  const s = STRINGS[locale];
  const provider = PROVIDER_NAMES[args.provider] ?? args.provider;
  const intro = (args.intent === "link" ? s.confirmLinkIntro : s.confirmIntro)
    .replace("{provider}", escapeHtml(provider))
    .replace("{label}", escapeHtml(args.label));
  return page(
    locale,
    s.confirmTitle,
    `  <section class="card" aria-labelledby="heading">
    <h1 id="heading">${s.confirmTitle}</h1>
    <div id="confirm-body">
    <p>${intro}</p>
    <p class="pairing">${escapeHtml(args.pairing)}</p>
    <p>${s.confirmWarning}</p>
    <button class="submit" id="btn" type="button">${s.confirmButton}</button>
    <button class="secondary" id="cancel" type="button">${s.cancelButton}</button>
    </div>
    <div class="status" id="status" role="alert" aria-live="polite"></div>
    <noscript><p class="status error">${s.noscript}</p></noscript>
  </section>`,
    {
      page: "confirm",
      s,
      flow: args.flow,
      confirm: args.confirm,
      provider: args.provider,
    },
  );
}

/** The end of an OAuth sign-in in a popup, an unknown identity, or an error. */
export function renderSignInResultPage(
  locale: PageLocale,
  args: { provider: string | null } & (
    | { kind: "unknown"; label: string }
    | { kind: "error"; code: string }
    | { kind: "done"; close: boolean; linked: boolean }
  ),
): string {
  const s = STRINGS[locale];
  const provider = args.provider
    ? (PROVIDER_NAMES[args.provider] ?? args.provider)
    : "";
  const heading =
    args.kind === "done"
      ? args.linked
        ? s.linkedHeading
        : s.doneHeading
      : args.kind === "unknown"
        ? s.unknownHeading
        : s.errorHeading;
  const text =
    args.kind === "done"
      ? s.doneClose
      : args.kind === "unknown"
        ? s.unknownIdentity
            .replace("{label}", escapeHtml(args.label))
            .replace("{provider}", escapeHtml(provider))
        : ((s as Record<string, string>)[`err_${args.code}`] ?? s.oauthFailed);
  return page(
    locale,
    s.resultTitle,
    `  <section class="card" aria-labelledby="heading">
    <h1 id="heading">${heading}</h1>
    <p>${text}</p>
    <div class="status" id="status" role="alert" aria-live="polite"></div>
    ${args.kind === "done" ? "" : `<p class="note"><a href="/login">${s.backToLogin}</a></p>`}
  </section>`,
    {
      page: "result",
      s,
      ...(args.kind === "done" && args.close ? { close: true } : {}),
    },
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
