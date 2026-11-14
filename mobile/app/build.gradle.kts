import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseProperties = Properties().apply {
    file("../version.properties").inputStream().use { load(it) }
}
val releaseVersionName = releaseProperties.getProperty("versionName")
    ?: error("mobile/version.properties must define versionName")
val releaseVersionCode = releaseProperties.getProperty("versionCode")?.toIntOrNull()
    ?.takeIf { it > 0 }
    ?: error("mobile/version.properties must define a positive versionCode")

android {
    buildFeatures { buildConfig = true }
    namespace = "com.chiliahedron.remcodex"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.chiliahedron.remcodex"
        minSdk = 26
        targetSdk = 34
        versionCode = releaseVersionCode
        versionName = releaseVersionName
    }

    buildTypes {
        debug { manifestPlaceholders["usesCleartextTraffic"] = "true" }
        release {
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            // Release APKs are intentionally unsigned. Signing is a separate, protected F-Droid step.
            signingConfig = null
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.1")
}
