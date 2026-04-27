// MINIMAL CSInterface stub for ae-mcp panel.
// REPLACE with the official Adobe CSInterface 11.x before ZXP packaging
// (vendor from https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_11.x/CSInterface.js — MIT).
// This stub covers only what plugin/client/client.js uses.

function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
    try {
        // CEP exposes window.__adobe_cep__ in the panel runtime.
        window.__adobe_cep__.evalScript(script, callback);
    } catch (e) {
        if (callback) callback("EvalScript error: " + e);
    }
};

CSInterface.prototype.getSystemPath = function (type) {
    try {
        return window.__adobe_cep__.getSystemPath(type);
    } catch (e) {
        return "";
    }
};

CSInterface.prototype.getExtensionID = function () {
    try {
        return window.__adobe_cep__.getExtensionId();
    } catch (e) {
        return "com.aemcp.panel";
    }
};

// SystemPath enum (only "extension" is used right now).
var SystemPath = {
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication",
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION_SUPPORT: "applicationSupport"
};
