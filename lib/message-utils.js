/**
 * Pure message-related utility functions extracted from the ReDraft client extension.
 * No DOM, no SillyTavern API — safe to test in Node.js.
 */

/**
 * Find the last user message in the interceptor's chat array and resolve its
 * real index in the full chat via send_date (with content fallback).
 *
 * The interceptor receives cloned message objects, so object-identity comparison
 * against fullChat won't work. This function uses send_date matching first, then
 * falls back to content matching for older ST versions.
 *
 * @param {object[]} interceptorChat - The (potentially cloned) chat array from the interceptor
 * @param {object[]} fullChat - The authoritative chat array from SillyTavern context
 * @returns {{ chatMsg: object|null, realIdx: number }}
 */
export function resolveUserMessageIndex(interceptorChat, fullChat) {
    let chatMsg = null;
    for (let i = interceptorChat.length - 1; i >= 0; i--) {
        if (interceptorChat[i].is_user && interceptorChat[i].mes) {
            chatMsg = interceptorChat[i];
            break;
        }
    }
    if (!chatMsg) return { chatMsg: null, realIdx: -1 };

    let realIdx = -1;
    const targetDate = chatMsg.send_date;
    if (targetDate) {
        for (let i = fullChat.length - 1; i >= 0; i--) {
            if (fullChat[i].send_date === targetDate) {
                realIdx = i;
                break;
            }
        }
    }
    // Fallback: match by content for older ST versions without send_date
    if (realIdx < 0) {
        for (let i = fullChat.length - 1; i >= 0; i--) {
            if (fullChat[i].is_user && fullChat[i].mes === chatMsg.mes) {
                realIdx = i;
                break;
            }
        }
    }

    return { chatMsg, realIdx };
}

/**
 * Map a refinement error message to a user-facing toast message and timeout.
 *
 * @param {string} errorMessage - The error's .message string
 * @returns {{ toastMessage: string, timeOut: number }}
 */
export function categorizeRefinementError(errorMessage) {
    const msg = errorMessage || '';

    if (msg.includes('not configured') || msg.includes('Please set up API credentials')) {
        return {
            toastMessage: 'ReDraft plugin isn\'t configured. In ReDraft settings, enter API URL, Key, and Model under Separate LLM, then click Save Connection.',
            timeOut: 8000,
        };
    }
    if (msg.includes('timed out')) {
        return {
            toastMessage: 'Refinement timed out \u2014 the LLM took too long to respond. Try a shorter message, a faster model, or check your API provider\'s status page.',
            timeOut: 8000,
        };
    }
    if (msg.includes('returned 401') || msg.includes('Unauthorized')) {
        return {
            toastMessage: 'API authentication failed (401). Your API key may be invalid or expired \u2014 check your key in ReDraft Connection settings.',
            timeOut: 8000,
        };
    }
    if (msg.includes('returned 402') || msg.includes('Payment Required') || msg.includes('insufficient')) {
        return {
            toastMessage: 'API billing error (402). Your account may be out of credits \u2014 check your balance on your API provider\'s dashboard.',
            timeOut: 8000,
        };
    }
    if (msg.includes('returned 429') || msg.includes('rate limit') || msg.includes('Rate limit')) {
        return {
            toastMessage: 'Rate limited by the API (429). Wait a moment and try again, or switch to a less busy model.',
            timeOut: 6000,
        };
    }
    if (msg.includes('returned 404')) {
        return {
            toastMessage: 'Model or endpoint not found (404). Check that your model name and API URL are correct in ReDraft Connection settings.',
            timeOut: 8000,
        };
    }
    if (msg.includes('returned 503')) {
        return {
            toastMessage: 'The API returned Service Unavailable (503). The model\'s backend is temporarily down \u2014 try again in a moment or switch to a different model.',
            timeOut: 8000,
        };
    }
    if (msg.includes('web page instead of JSON')) {
        return {
            toastMessage: 'Server returned HTML instead of JSON. If you use a reverse proxy, check its timeout settings (need at least 90s). Otherwise check the SillyTavern terminal for errors.',
            timeOut: 10000,
        };
    }

    return {
        toastMessage: msg || 'Refinement failed \u2014 check the browser console for details.',
        timeOut: 8000,
    };
}
