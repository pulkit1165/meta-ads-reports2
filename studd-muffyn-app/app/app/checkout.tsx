// Fully in-app checkout. Renders the Shiprocket/Shopify checkout inside the
// app (no browser chrome) and — critically — lets UPI apps take over when the
// customer picks GPay / PhonePe / Paytm, then come back here.
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { useShop } from '../src/store/shop';
import { colors, type as t } from '../src/theme';

// Anything that isn't plain web traffic is a payment app handing off.
const EXTERNAL_SCHEME = /^(upi|tez|phonepe|paytmmp|gpay|credpay|bhim|intent|itms-appss?|whatsapp|tel|mailto):/i;
const SUCCESS_HINT = /(order-success|thank[_-]?you|\/orders\/|ost=SUCCESS)/i;

export default function Checkout() {
  const { url, fallback } = useLocalSearchParams<{ url: string; fallback?: string }>();
  const router = useRouter();
  const clearCart = useShop((s) => s.clearCart);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const webRef = useRef<WebView>(null);
  const canGoBack = useRef(false);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  // Android hardware back should step through checkout, not exit it
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current && !done) {
        webRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [done]);

  const onNavChange = (nav: WebViewNavigation) => {
    canGoBack.current = nav.canGoBack;
    if (!done && SUCCESS_HINT.test(nav.url)) {
      setDone(true);
      clearCart();
    }
  };

  // Payment apps (UPI etc.) use custom schemes a WebView can't load itself —
  // hand them to the OS, otherwise checkout dead-ends at "pay".
  const onShouldStart = (req: { url: string }) => {
    const u = req.url || '';
    if (EXTERNAL_SCHEME.test(u)) {
      Linking.openURL(u).catch(() =>
        Alert.alert('Payment app not found', 'Please choose another payment method.')
      );
      return false;
    }
    return true;
  };

  if (!url) {
    return (
      <SafeAreaView style={s.center}>
        <Text style={s.msg}>Checkout link missing.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <View style={s.bar}>
        <Pressable hitSlop={12} onPress={leave}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={s.title}>{done ? 'Order Placed' : 'Secure Checkout'}</Text>
        <Ionicons name="lock-closed" size={16} color={colors.textDim} />
      </View>

      <WebView
        ref={webRef}
        source={{ uri: String(url) }}
        style={{ flex: 1, backgroundColor: colors.bg }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        // keep the Shopify/Shiprocket session intact across redirects
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        onShouldStartLoadWithRequest={onShouldStart}
        onNavigationStateChange={onNavChange}
        onLoadEnd={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          Alert.alert(
            'Checkout could not load',
            'Open it in the browser instead?',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Open',
                onPress: () => WebBrowser.openBrowserAsync(String(fallback || url)),
              },
            ]
          );
        }}
      />

      {loading && (
        <View style={s.loading} pointerEvents="none">
          <ActivityIndicator size="large" color={colors.gold} />
          <Text style={s.msg}>Opening secure checkout…</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.header,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  title: { ...t.display, color: colors.text, fontSize: 17 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  loading: {
    position: 'absolute',
    top: 60, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bg, gap: 12,
  },
  msg: { color: colors.textDim, fontSize: 13.5 },
});
