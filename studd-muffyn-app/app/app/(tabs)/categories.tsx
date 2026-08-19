// Shop tab — mirrors the website's menu drawer, live from the site
// (via /api/home-config). Falls back to a bundled snapshot offline.
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useHomeConfig } from '../../src/api/remoteConfig';
import { colors, type as t } from '../../src/theme';

interface MenuItem {
  title: string;
  url: string;
  children?: MenuItem[];
}

// offline fallback — snapshot of the site menu
const FALLBACK: MenuItem[] = [
  { title: 'Gold Plated Jewellery', url: '/collections/24k-gold-plated-jewellery', children: [] },
  { title: 'Crystal Home Decor', url: '/collections/crystal-home-decor-collection', children: [] },
  { title: 'Crystals', url: '/collections/crystal-2', children: [] },
  { title: 'Best Seller', url: '/collections/best-seller-2025', children: [] },
  { title: 'New Launches', url: '/collections/studd-muffyn-new-launches', children: [] },
  { title: 'Hair Care', url: '/collections/hair-care-bestsellers', children: [] },
  { title: 'Skin Care', url: '/collections/skin-care-bestsellers', children: [] },
  { title: 'Perfumes', url: '/collections/perfume-best-sellers', children: [] },
  { title: 'Nutraceuticals', url: '/collections/nutraceuticals', children: [] },
  { title: 'Gifting Collection', url: '/collections/gifting-collection-1', children: [] },
  { title: 'Money saving Combos', url: '/collections/nuskhe-combos', children: [] },
];

export default function Categories() {
  const router = useRouter();
  const cfg = useHomeConfig() as any;
  const menu: MenuItem[] = cfg?.menu?.length ? cfg.menu : FALLBACK;
  const [open, setOpen] = useState<number | null>(null);

  const go = (url: string) => {
    const c = url.match(/\/collections\/([a-z0-9-]+)/);
    if (c) return router.push(`/collection/${c[1]}`);
    if (/^\/?pages\/|^https?:/.test(url) || url.startsWith('/pages')) {
      const full = url.startsWith('http') ? url : `https://studdmuffyn.com${url}`;
      WebBrowser.openBrowserAsync(full);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <Text style={s.title}>Shop</Text>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 130 }}>
        {menu.map((item, i) => {
          const hasKids = !!item.children?.length;
          const expanded = open === i;
          return (
            <View key={item.title + i}>
              <Pressable
                style={s.row}
                onPress={() => (hasKids ? setOpen(expanded ? null : i) : go(item.url))}
              >
                <Text style={s.rowText}>{item.title}</Text>
                <Ionicons
                  name={hasKids ? (expanded ? 'chevron-up' : 'chevron-down') : 'chevron-forward'}
                  size={17}
                  color={hasKids ? colors.gold : colors.textFaint}
                />
              </Pressable>
              {expanded && (
                <Animated.View entering={FadeIn.duration(180)} style={s.subWrap}>
                  {item.url && item.url !== '/' ? (
                    <Pressable style={s.subRow} onPress={() => go(item.url)}>
                      <Text style={[s.subText, { color: colors.goldSoft, fontWeight: '700' }]}>
                        View all {item.title}
                      </Text>
                    </Pressable>
                  ) : null}
                  {item.children!.map((ch, j) => (
                    <Pressable key={ch.title + j} style={s.subRow} onPress={() => go(ch.url)}>
                      <Text style={s.subText}>{ch.title}</Text>
                      <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
                    </Pressable>
                  ))}
                </Animated.View>
              )}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  title: { ...t.display, color: colors.text, fontSize: 28, paddingHorizontal: 20, paddingVertical: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 17,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowText: { ...t.display, color: colors.text, fontSize: 17 },
  subWrap: { backgroundColor: colors.surface, paddingVertical: 4 },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 32,
    paddingRight: 20,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  subText: { color: colors.textDim, fontSize: 14.5 },
});
