// Premium product card — image, badges, wishlist heart, quick add.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import type { Product } from '../api/types';
import { startCheckoutUrl } from '../api/shopify';
import { useExtrasIndex } from '../api/extras';
import { colors, INR, pctOff, radius, shadow, type as t } from '../theme';
import { useShop } from '../store/shop';
import { Badge } from './ui';

export function ProductCard({
  product,
  width = 168,
  index = 0,
}: {
  product: Product;
  width?: number;
  index?: number;
}) {
  const router = useRouter();
  const { wishlist, toggleWish, addToCart } = useShop();
  const idx = useExtrasIndex();
  const mkt = idx?.[product.handle];
  const wished = wishlist.includes(product.handle);
  const off = pctOff(product.price, product.compareAt);
  const soldOut = product.variants.length > 0 && product.variants.every((v) => !v.available);

  const [added, setAdded] = React.useState(false);
  const quickAdd = () => {
    const v = product.variants.find((x) => x.available) ?? product.variants[0];
    if (!v) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    addToCart({
      handle: product.handle,
      variantId: v.id,
      variantTitle: v.title,
      title: product.title,
      image: product.images[0],
      price: v.price,
      compareAt: v.compareAt,
    });
    setAdded(true);
    setTimeout(() => setAdded(false), 1400);
  };

  const buyNow = async () => {
    const v = product.variants.find((x) => x.available) ?? product.variants[0];
    if (!v) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await WebBrowser.openBrowserAsync(await startCheckoutUrl([{ variantId: v.id, qty: 1 }]));
  };

  return (
    <View style={{ width }}>
      <Pressable
        onPress={() => router.push(`/product/${product.handle}`)}
        style={[s.card, shadow.card]}
      >
        <View style={s.imageWrap}>
          <Image
            source={{ uri: product.images[0] }}
            style={s.image}
            contentFit="cover"
            transition={250}
            recyclingKey={product.handle}
          />
          <View style={s.badges}>
            {off > 0 && <Badge label={`${off}% OFF`} tone="gold" />}
            {soldOut && <Badge label="SOLD OUT" tone="dark" />}
          </View>
          <Pressable
            hitSlop={8}
            style={s.heart}
            onPress={() => {
              Haptics.selectionAsync();
              toggleWish(product.handle);
            }}
          >
            <Ionicons name={wished ? 'heart' : 'heart-outline'} size={18} color={wished ? colors.gold : '#fff'} />
          </Pressable>
        </View>
        <View style={s.info}>
          <Text numberOfLines={2} style={s.title}>
            {product.title}
          </Text>
          <View style={s.priceRow}>
            <Text style={[s.price, product.compareAt && product.compareAt > product.price ? { color: colors.sale } : null]}>{INR(product.price)}</Text>
            {product.compareAt && product.compareAt > product.price ? (
              <Text style={s.compare}>{INR(product.compareAt)}</Text>
            ) : null}
          </View>
          {!soldOut && (
            <View style={s.btnRow}>
              <Pressable style={[s.cardBtn, s.atcCardBtn]} onPress={quickAdd}>
                <Text numberOfLines={1} style={[s.cardBtnText, { color: colors.goldSoft }]}>{added ? 'Added ✓' : 'Add to Cart'}</Text>
              </Pressable>
              <Pressable style={[s.cardBtn, s.buyCardBtn]} onPress={buyNow}>
                <Text numberOfLines={1} style={[s.cardBtnText, { color: colors.cream }]}>Buy Now</Text>
              </Pressable>
            </View>
          )}
          {mkt && (mkt.a || mkt.f) ? (
            <View style={s.mktWrap}>
              <Text style={s.mktCaption}>— Also Available On —</Text>
              <View style={s.mktBtns}>
                {mkt.a ? (
                  <Pressable style={s.mktMini} onPress={() => WebBrowser.openBrowserAsync(mkt.a!)}>
                    <Text style={s.mktMiniLabel}>Buy from</Text>
                    <Text style={[s.mktMiniName, { color: '#f90' }]}>amazon</Text>
                  </Pressable>
                ) : null}
                {mkt.f ? (
                  <Pressable style={s.mktMini} onPress={() => WebBrowser.openBrowserAsync(mkt.f!)}>
                    <Text style={s.mktMiniLabel}>Buy from</Text>
                    <Text style={[s.mktMiniName, { color: '#2874f0' }]}>Flipkart</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  imageWrap: { aspectRatio: 0.92, backgroundColor: colors.surfaceHi },
  image: { flex: 1 },
  badges: { position: 'absolute', top: 10, left: 10, gap: 6, flexDirection: 'row' },
  heart: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { padding: 12, paddingBottom: 14 },
  title: { color: colors.text, fontSize: 13, lineHeight: 18, fontWeight: '500', minHeight: 36 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 7, marginTop: 7 },
  price: { ...t.display, color: colors.text, fontSize: 16, fontWeight: '700' },
  compare: { color: colors.textFaint, fontSize: 12, textDecorationLine: 'line-through' },
  btnRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  cardBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  atcCardBtn: { borderWidth: 1, borderColor: colors.gold, backgroundColor: colors.card },
  buyCardBtn: { backgroundColor: colors.gold },
  cardBtnText: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.2 },
  mktWrap: { marginTop: 10, alignItems: 'center', gap: 6 },
  mktCaption: { color: colors.textFaint, fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4 },
  mktBtns: { flexDirection: 'row', gap: 6, alignSelf: 'stretch' },
  mktMini: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingVertical: 5,
    alignItems: 'center',
    backgroundColor: colors.card,
  },
  mktMiniLabel: { color: colors.textFaint, fontSize: 8.5 },
  mktMiniName: { fontSize: 11.5, fontWeight: '800' },
});
