package com.chiliahedron.remcodex

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.FrameLayout
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var errorView: TextView
    private var trustedOrigin: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        webView = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.loadsImagesAutomatically = true
            settings.allowFileAccess = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    return !isAllowedServer(uri) || origin(uri) != trustedOrigin
                }

                override fun onPageFinished(view: WebView, url: String) {
                    errorView.visibility = View.GONE
                    webView.visibility = View.VISIBLE
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError,
                ) {
                    if (request.isForMainFrame) showLoadError()
                }
            }
        }

        errorView = TextView(this).apply {
            setText(R.string.mobile_load_error)
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(16, 17, 22))
            setPadding(48, 48, 48, 48)
            visibility = View.GONE
        }

        setContentView(FrameLayout(this).apply {
            addView(webView, FrameLayout.LayoutParams(-1, -1))
            addView(errorView, FrameLayout.LayoutParams(-1, -1))
        })
        loadServer(resolveServerUri(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        loadServer(resolveServerUri(intent))
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    private fun loadServer(uri: Uri) {
        if (!isAllowedServer(uri)) { showLoadError(); return }
        trustedOrigin = origin(uri)
        webView.visibility = View.VISIBLE
        webView.loadUrl(uri.toString())
    }

    private fun origin(uri: Uri): String = "${uri.scheme}://${uri.host}:${uri.port}"

    private fun isAllowedServer(uri: Uri): Boolean = uri.host != null && uri.userInfo == null &&
        (uri.scheme == "https" || (BuildConfig.DEBUG && uri.scheme == "http"))

    private fun resolveServerUri(sourceIntent: Intent): Uri {
        val configuredUrl = sourceIntent.getStringExtra(EXTRA_SERVER_URL)
            ?: sourceIntent.data?.toString()
        return Uri.parse(configuredUrl ?: getString(R.string.mobile_default_url))
    }

    private fun showLoadError() {
        webView.visibility = View.GONE
        errorView.visibility = View.VISIBLE
    }

    companion object {
        const val EXTRA_SERVER_URL = "com.chiliahedron.remcodex.SERVER_URL"
    }
}
