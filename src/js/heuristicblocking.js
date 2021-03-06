/*
 * This file is part of Privacy Badger <https://www.eff.org/privacybadger>
 * Copyright (C) 2014 Electronic Frontier Foundation
 *
 * Privacy Badger is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Privacy Badger is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Privacy Badger.  If not, see <http://www.gnu.org/licenses/>.
 */

/* globals badger:false, log:false, URI:false */

var constants = require("constants");
var utils = require("utils");
var incognito = require("incognito");

require.scopes.heuristicblocking = (function() {



/*********************** heuristicblocking scope **/
// make heuristic obj with utils and storage properties and put the things on it
function HeuristicBlocker(pbStorage) {
  this.storage = pbStorage;

  // TODO roll into tabData? -- 6/10/2019 not for now, since tabData is populated
  // by the synchronous listeners in webrequests.js and tabOrigins is used by the
  // async listeners here; there's no way to enforce ordering of requests among
  // those two. Also, tabData is cleaned up every time a tab is closed, so
  // dangling requests that don't trigger listeners until after the tab closes are
  // impossible to attribute to a tab.
  this.tabOrigins = {};
  this.tabUrls = {};
}

HeuristicBlocker.prototype = {
  /**
   * Adds Cookie blocking for all more specific domains than the blocked origin
   * - if they're on the cb list
   *
   * @param {String} origin Origin to check
   */
  setupSubdomainsForCookieblock: function(origin) {
    var cbl = this.storage.getBadgerStorageObject("cookieblock_list");
    for (var domain in cbl.getItemClones()) {
      if (origin == window.getBaseDomain(domain)) {
        this.storage.setupHeuristicAction(domain, constants.COOKIEBLOCK);
      }
    }
    // iterate through all elements of cookie block list
    // if element has basedomain add it to action_map
    // or update it's action with cookieblock
    origin = null;
    return false;
  },

  /**
   * Decide if to blacklist and add blacklist filters
   * @param {String} baseDomain The base domain (etld+1) to blacklist
   * @param {String} fqdn The FQDN
   */
  blacklistOrigin: function(baseDomain, fqdn) {
    var cbl = this.storage.getBadgerStorageObject("cookieblock_list");

    // Setup Cookieblock or block for base domain and fqdn
    if (cbl.hasItem(baseDomain)) {
      this.storage.setupHeuristicAction(baseDomain, constants.COOKIEBLOCK);
    } else {
      this.storage.setupHeuristicAction(baseDomain, constants.BLOCK);
    }

    // Check if a parent domain of the fqdn is on the cookie block list
    var set = false;
    var thisStorage = this.storage;
    _.each(utils.explodeSubdomains(fqdn, true), function(domain) {
      if (cbl.hasItem(domain)) {
        thisStorage.setupHeuristicAction(fqdn, constants.COOKIEBLOCK);
        set = true;
      }
    });
    // if no parent domains are on the cookie block list then block fqdn
    if (!set) {
      this.storage.setupHeuristicAction(fqdn, constants.BLOCK);
    }

    this.setupSubdomainsForCookieblock(baseDomain);
  },

  /**
   * Wraps _recordPrevalence for use from webRequest listeners.
   * Use updateTrackerPrevalence for non-webRequest initiated bookkeeping.
   *
   * @param {Object} details request/response details
   * @param {Boolean} check_for_cookie_share whether to check for cookie sharing
   */
  heuristicBlockingAccounting: function (details, check_for_cookie_share) {
    // ignore requests that are outside a tabbed window
    if (details.tabId < 0 || !incognito.learningEnabled(details.tabId)) {
      return {};
    }

    let self = this,
      request_host = (new URI(details.url)).host,
      request_origin = window.getBaseDomain(request_host);

    // if this is a main window request, update tab data and quit
    if (details.type == "main_frame") {
      self.tabOrigins[details.tabId] = request_origin;
      self.tabUrls[details.tabId] = details.url;
      return {};
    }

    let tab_origin = self.tabOrigins[details.tabId];

    // ignore first-party requests
    if (!tab_origin || !utils.isThirdPartyDomain(request_origin, tab_origin)) {
      return {};
    }

    // short-circuit if we already observed this origin tracking on this site
    let firstParties = self.storage.getBadgerStorageObject('snitch_map').getItem(request_origin);
    if (firstParties && firstParties.indexOf(tab_origin) > -1) {
      return {};
    }

    // abort if we already made a decision for this FQDN
    let action = self.storage.getAction(request_host);
    if (action != constants.NO_TRACKING && action != constants.ALLOW) {
      return {};
    }

    // check if there are tracking cookies
    if (hasCookieTracking(details, request_origin)) {
      self._recordPrevalence(request_host, request_origin, tab_origin);
      return {};
    }

    // check for cookie sharing iff this is an image and the request URL has parameters
    if (check_for_cookie_share && details.type == 'image' && details.url.indexOf('?') > -1) {
      // get all cookies for the top-level frame and pass those to the
      // cookie-share accounting function
      let tab_url = self.tabUrls[details.tabId];

      let config = {
        url: tab_url
      };
      if (badger.firstPartyDomainPotentiallyRequired) {
        config.firstPartyDomain = null;
      }

      chrome.cookies.getAll(config, function (cookies) {
        if (cookies.length >= 1) {
          self.pixelCookieShareAccounting(tab_url, tab_origin, details.url, request_host, request_origin, cookies);
        }
      });
    }
  },

  /**
   * Checks for cookie sharing: requests to third-party domains that include
   * high entropy data from first-party cookies (associated with the top-level
   * frame). Only catches plain-text verbatim sharing (b64 encoding + the like
   * defeat it). Assumes any long string that doesn't contain URL fragments or
   * stopwords is an identifier.  Doesn't catch cookie syncing (3rd party -> 3rd
   * party), but most of those tracking cookies should be blocked anyway.
   *
   * @param details are those from onBeforeSendHeaders
   * @param cookies are the result of chrome.cookies.getAll()
   * @returns {*}
   */
  pixelCookieShareAccounting: function (tab_url, tab_origin, request_url, request_host, request_origin, cookies) {
    let params = (new URL(request_url)).searchParams,
      TRACKER_ENTROPY_THRESHOLD = 33,
      MIN_STR_LEN = 8;

    for (let p of params) {
      let key = p[0],
        value = p[1];

      // the argument must be sufficiently long
      if (!value || value.length < MIN_STR_LEN) {
        continue;
      }

      // check if this argument is derived from a high-entropy first-party cookie
      for (let cookie of cookies) {
        // the cookie value must be sufficiently long
        if (!cookie.value || cookie.value.length < MIN_STR_LEN) {
          continue;
        }

        // find the longest common substring between this arg and the cookies
        // associated with the document
        let substrings = utils.findCommonSubstrings(cookie.value, value) || [];
        for (let s of substrings) {
          // ignore the substring if it's part of the first-party URL. sometimes
          // content servers take the url of the page they're hosting content
          // for as an argument. e.g.
          // https://example-cdn.com/content?u=http://example.com/index.html
          if (tab_url.indexOf(s) != -1) {
            continue;
          }

          // elements of the user agent string are also commonly included in
          // both cookies and arguments; e.g. "Mozilla/5.0" might be in both.
          // This is not a special tracking risk since third parties can see
          // this info anyway.
          if (navigator.userAgent.indexOf(s) != -1) {
            continue;
          }

          // Sometimes the entire url and then some is included in the
          // substring -- the common string might be "https://example.com/:true"
          // In that case, we only care about the information around the URL.
          if (s.indexOf(tab_url) != -1) {
            s = s.replace(tab_url, "");
          }

          // During testing we found lots of common values like "homepage",
          // "referrer", etc. were being flagged as high entropy. This searches
          // for a few of those and removes them before we go further.
          let lower = s.toLowerCase();
          lowEntropyQueryValues.forEach(function (qv) {
            let start = lower.indexOf(qv);
            if (start != -1) {
              s = s.replace(s.substring(start, start + qv.length), "");
            }
          });

          // at this point, since we might have removed things, make sure the
          // string is still long enough to bother with
          if (s.length < MIN_STR_LEN) {
            continue;
          }

          // compute the entropy of this common substring. if it's greater than
          // our threshold, record the tracking action and exit the function.
          let entropy = utils.estimateMaxEntropy(s);
          if (entropy > TRACKER_ENTROPY_THRESHOLD) {
            log("Found high-entropy cookie share from", tab_origin, "to", request_host,
              ":", entropy, "bits\n  cookie:", cookie.name, '=', cookie.value,
              "\n  arg:", key, "=", value, "\n  substring:", s);
            this._recordPrevalence(request_host, request_origin, tab_origin);
            return;
          }
        }
      }
    }
  },

  /**
   * Wraps _recordPrevalence for use outside of webRequest listeners.
   *
   * @param {String} tracker_fqdn The fully qualified domain name of the tracker
   * @param {String} page_origin The base domain of the page
   *   where the tracker was detected.
   * @param {Boolean} skip_dnt_check Skip DNT policy checking if flag is true.
   *
   */
  updateTrackerPrevalence: function(tracker_fqdn, page_origin, skip_dnt_check) {
    // abort if we already made a decision for this fqdn
    let action = this.storage.getAction(tracker_fqdn);
    if (action != constants.NO_TRACKING && action != constants.ALLOW) {
      return;
    }

    this._recordPrevalence(
      tracker_fqdn,
      window.getBaseDomain(tracker_fqdn),
      page_origin,
      skip_dnt_check
    );
  },

  /**
   * Record HTTP request prevalence. Block a tracker if seen on more
   * than constants.TRACKING_THRESHOLD pages
   *
   * NOTE: This is a private function and should never be called directly.
   * All calls should be routed through heuristicBlockingAccounting for normal usage
   * and updateTrackerPrevalence for manual modifications (e.g. importing
   * tracker lists).
   *
   * @param {String} tracker_fqdn The FQDN of the third party tracker
   * @param {String} tracker_origin Base domain of the third party tracker
   * @param {String} page_origin The origin of the page where the third party
   *   tracker was loaded.
   * @param {Boolean} skip_dnt_check Skip DNT policy checking if flag is true.
   */
  _recordPrevalence: function (tracker_fqdn, tracker_origin, page_origin, skip_dnt_check) {
    var snitchMap = this.storage.getBadgerStorageObject('snitch_map');
    var firstParties = [];
    if (snitchMap.hasItem(tracker_origin)) {
      firstParties = snitchMap.getItem(tracker_origin);
    }

    if (firstParties.indexOf(page_origin) != -1) {
      return; // We already know about the presence of this tracker on the given domain
    }

    // Check this just-seen-tracking-on-this-site,
    // not-yet-blocked domain for DNT policy.
    // We check heuristically-blocked domains in webrequest.js.
    if (!skip_dnt_check) {
      setTimeout(function () {
        badger.checkForDNTPolicy(tracker_fqdn);
      }, 0);
    }

    // record that we've seen this tracker on this domain (in snitch map)
    firstParties.push(page_origin);
    snitchMap.setItem(tracker_origin, firstParties);

    // ALLOW indicates this is a tracker still below TRACKING_THRESHOLD
    // (vs. NO_TRACKING for resources we haven't seen perform tracking yet).
    // see https://github.com/EFForg/privacybadger/pull/1145#discussion_r96676710
    // TODO missing tests: removing below lines/messing up parameters
    // should break integration tests, but currently does not
    this.storage.setupHeuristicAction(tracker_fqdn, constants.ALLOW);
    this.storage.setupHeuristicAction(tracker_origin, constants.ALLOW);

    // Blocking based on outbound cookies
    var httpRequestPrevalence = firstParties.length;

    // block the origin if it has been seen on multiple first party domains
    if (httpRequestPrevalence >= constants.TRACKING_THRESHOLD) {
      log('blacklisting origin', tracker_fqdn);
      this.blacklistOrigin(tracker_origin, tracker_fqdn);
    }
  }
};


// This maps cookies to a rough estimate of how many bits of
// identifying info we might be letting past by allowing them.
// (map values to lower case before using)
// TODO: We need a better heuristic
var lowEntropyCookieValues = {
  "":3,
  "nodata":3,
  "no_data":3,
  "yes":3,
  "no":3,
  "true":3,
  "false":3,
  "dnt":3,
  "opt-out":3,
  "optout":3,
  "opt_out":3,
  "0":4,
  "1":4,
  "2":4,
  "3":4,
  "4":4,
  "5":4,
  "6":4,
  "7":4,
  "8":4,
  "9":4,
  // ISO 639-1 language codes
  "aa":8,
  "ab":8,
  "ae":8,
  "af":8,
  "ak":8,
  "am":8,
  "an":8,
  "ar":8,
  "as":8,
  "av":8,
  "ay":8,
  "az":8,
  "ba":8,
  "be":8,
  "bg":8,
  "bh":8,
  "bi":8,
  "bm":8,
  "bn":8,
  "bo":8,
  "br":8,
  "bs":8,
  "by":8,
  "ca":8,
  "ce":8,
  "ch":8,
  "co":8,
  "cr":8,
  "cs":8,
  "cu":8,
  "cv":8,
  "cy":8,
  "da":8,
  "de":8,
  "dv":8,
  "dz":8,
  "ee":8,
  "el":8,
  "en":8,
  "eo":8,
  "es":8,
  "et":8,
  "eu":8,
  "fa":8,
  "ff":8,
  "fi":8,
  "fj":8,
  "fo":8,
  "fr":8,
  "fy":8,
  "ga":8,
  "gd":8,
  "gl":8,
  "gn":8,
  "gu":8,
  "gv":8,
  "ha":8,
  "he":8,
  "hi":8,
  "ho":8,
  "hr":8,
  "ht":8,
  "hu":8,
  "hy":8,
  "hz":8,
  "ia":8,
  "id":8,
  "ie":8,
  "ig":8,
  "ii":8,
  "ik":8,
  "in":8,
  "io":8,
  "is":8,
  "it":8,
  "iu":8,
  "ja":8,
  "jv":8,
  "ka":8,
  "kg":8,
  "ki":8,
  "kj":8,
  "kk":8,
  "kl":8,
  "km":8,
  "kn":8,
  "ko":8,
  "kr":8,
  "ks":8,
  "ku":8,
  "kv":8,
  "kw":8,
  "ky":8,
  "la":8,
  "lb":8,
  "lg":8,
  "li":8,
  "ln":8,
  "lo":8,
  "lt":8,
  "lu":8,
  "lv":8,
  "mg":8,
  "mh":8,
  "mi":8,
  "mk":8,
  "ml":8,
  "mn":8,
  "mr":8,
  "ms":8,
  "mt":8,
  "my":8,
  "na":8,
  "nb":8,
  "nd":8,
  "ne":8,
  "ng":8,
  "nl":8,
  "nn":8,
  "nr":8,
  "nv":8,
  "ny":8,
  "oc":8,
  "of":8,
  "oj":8,
  "om":8,
  "or":8,
  "os":8,
  "pa":8,
  "pi":8,
  "pl":8,
  "ps":8,
  "pt":8,
  "qu":8,
  "rm":8,
  "rn":8,
  "ro":8,
  "ru":8,
  "rw":8,
  "sa":8,
  "sc":8,
  "sd":8,
  "se":8,
  "sg":8,
  "si":8,
  "sk":8,
  "sl":8,
  "sm":8,
  "sn":8,
  "so":8,
  "sq":8,
  "sr":8,
  "ss":8,
  "st":8,
  "su":8,
  "sv":8,
  "sw":8,
  "ta":8,
  "te":8,
  "tg":8,
  "th":8,
  "ti":8,
  "tk":8,
  "tl":8,
  "tn":8,
  "to":8,
  "tr":8,
  "ts":8,
  "tt":8,
  "tw":8,
  "ty":8,
  "ug":8,
  "uk":8,
  "ur":8,
  "uz":8,
  "ve":8,
  "vi":8,
  "vo":8,
  "wa":8,
  "wo":8,
  "xh":8,
  "yi":8,
  "yo":8,
  "za":8,
  "zh":8,
  "zu":8
};

const lowEntropyQueryValues = [
  "https",
  "http",
  "://",
  "%3A%2F%2F",
  "www",
  "url",
  "undefined",
  "impression",
  "session",
  "homepage",
  "client",
  "version",
  "business",
  "title",
  "get",
  "site",
  "name",
  "category",
  "account_id",
  "smartadserver",
  "front",
  "page",
  "view",
  "first",
  "visit",
  "platform",
  "language",
  "automatic",
  "disabled",
  "landing",
  "entertainment",
  "amazon",
  "official",
  "webvisor",
  "anonymous",
  "across",
  "narrative",
  "\":null",
  "\":false",
  "\":\"",
  "\",\"",
  "\",\"",
];

/**
 * Extract cookies from onBeforeSendHeaders
 *
 * @param details Details for onBeforeSendHeaders
 * @returns {*} an array combining all Cookies
 */
function _extractCookies(details) {
  let cookies = [],
    headers = [];

  if (details.requestHeaders) {
    headers = details.requestHeaders;
  } else if (details.responseHeaders) {
    headers = details.responseHeaders;
  }

  for (let i = 0; i < headers.length; i++) {
    let header = headers[i];
    if (header.name.toLowerCase() == "cookie" || header.name.toLowerCase() == "set-cookie") {
      cookies.push(header.value);
    }
  }

  return cookies;
}

/**
 * Check if page is doing cookie tracking. Doing this by estimating the entropy of the cookies
 *
 * @param details details onBeforeSendHeaders details
 * @param {String} origin URL
 * @returns {boolean} true if it has cookie tracking
 */
function hasCookieTracking(details, origin) {
  let cookies = _extractCookies(details);
  if (!cookies.length) {
    return false;
  }

  let estimatedEntropy = 0;

  // loop over every cookie
  for (let i = 0; i < cookies.length; i++) {
    let cookie = utils.parseCookie(cookies[i], {
      noDecode: true,
      skipAttributes: true,
      skipNonValues: true
    });

    // loop over every name/value pair in every cookie
    for (let name in cookie) {
      if (!cookie.hasOwnProperty(name)) {
        continue;
      }

      // ignore CloudFlare
      if (name == "__cfduid") {
        continue;
      }

      let value = cookie[name].toLowerCase();

      if (!(value in lowEntropyCookieValues)) {
        return true;
      }

      estimatedEntropy += lowEntropyCookieValues[value];
    }
  }

  log("All cookies for " + origin + " deemed low entropy...");
  if (estimatedEntropy > constants.MAX_COOKIE_ENTROPY) {
    log("But total estimated entropy is " + estimatedEntropy + " bits, so blocking");
    return true;
  }

  return false;
}

function startListeners() {
  /**
   * Adds heuristicBlockingAccounting as listened to onBeforeSendHeaders request
   */
  let extraInfoSpec = ['requestHeaders'];
  if (chrome.webRequest.OnBeforeSendHeadersOptions.hasOwnProperty('EXTRA_HEADERS')) {
    extraInfoSpec.push('extraHeaders');
  }
  chrome.webRequest.onBeforeSendHeaders.addListener(function(details) {
    return badger.heuristicBlocking.heuristicBlockingAccounting(details, true);
  }, {urls: ["<all_urls>"]}, extraInfoSpec);

  /**
   * Adds onResponseStarted listener. Monitor for cookies
   */
  extraInfoSpec = ['responseHeaders'];
  if (chrome.webRequest.OnResponseStartedOptions.hasOwnProperty('EXTRA_HEADERS')) {
    extraInfoSpec.push('extraHeaders');
  }
  chrome.webRequest.onResponseStarted.addListener(function(details) {
    var hasSetCookie = false;
    for (var i = 0; i < details.responseHeaders.length; i++) {
      if (details.responseHeaders[i].name.toLowerCase() == "set-cookie") {
        hasSetCookie = true;
        break;
      }
    }
    if (hasSetCookie) {
      return badger.heuristicBlocking.heuristicBlockingAccounting(details, false);
    }
  },
  {urls: ["<all_urls>"]}, extraInfoSpec);
}

/************************************** exports */
var exports = {};
exports.HeuristicBlocker = HeuristicBlocker;
exports.startListeners = startListeners;
exports.hasCookieTracking = hasCookieTracking;
return exports;
/************************************** exports */
})();
