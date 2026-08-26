// Home — fully driven by src/config/home.json (merch dashboard-ready).
import React, { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useHomeConfig } from '../../src/api/remoteConfig';
import {
  AnnouncementTicker,
  BigBanner,
  CategoryGrid,
  Hero,
  IconRow,
  ImageBanner,
  LogoStrip,
  OfferCards,
  ProductRail,
  PurposeGrid,
  SectionTitle,
} from '../../src/components/HomeSections';
import { getProduct } from '../../src/api/shopify';
import { useShop } from '../../src/store/shop';
import { colors } from '../../src/theme';

function Header() {
  const router = useRouter();
  return (
    <View style={s.header}>
      <Image source={require('../../assets/logo.png')} style={s.logo} contentFit="contain" />
      <View style={{ flex: 1 }} />
      <Pressable hitSlop={10} onPress={() => router.push('/(tabs)/search')} style={s.hIcon}>
        <Ionicons name="search-outline" size={22} color={colors.text} />
      </Pressable>
      <Pressable hitSlop={10} onPress={() => router.push('/cart')} style={s.hIcon}>
        <Ionicons name="bag-handle-outline" size={22} color={colors.text} />
      </Pressable>
    </View>
  );
}

function RecentlyViewed({ title }: { title: string }) {
  const recents = useShop((st) => st.recents);
  const products = useMemo(
    () => recents.map((h) => getProduct(h)).filter(Boolean) as NonNullable<ReturnType<typeof getProduct>>[],
    [recents]
  );
  if (!products.length) return null;
  return <ProductRail title={title} products={products.slice(0, 12)} />;
}

export default function Home() {
  const cfg = useHomeConfig() as any;
  const sections = (cfg.sections || []) as any[];

  const renderSection = (sec: any, i: number) => {
    switch (sec.type) {
      case 'hero':
        return <Hero slides={sec.slides} aspect={sec.aspect} />;
      case 'iconRow':
        return <IconRow items={sec.items} />;
      case 'logoStrip':
        return <LogoStrip images={sec.images} height={sec.height} />;
      case 'imageBanner':
        return <ImageBanner image={sec.image} url={sec.url} aspect={sec.aspect} />;
      case 'sectionTitle':
        return <SectionTitle text={sec.text} />;
      case 'categoryGrid':
        return (
          <CategoryGrid
            title={sec.title}
            items={sec.items}
            aspect={sec.aspect}
            showLabel={sec.showLabel !== false}
            labelMode={sec.labelMode}
          />
        );
      case 'productRail':
        return <ProductRail title={sec.title} subtitle={sec.subtitle} handle={sec.handle} />;
      case 'offerCards':
        return <OfferCards title={sec.title} items={sec.items} />;
      case 'purposeGrid':
        return <PurposeGrid title={sec.title} subtitle={sec.subtitle} items={sec.items} />;
      case 'bigBanner':
        return <BigBanner title={sec.title} subtitle={sec.subtitle} handle={sec.handle} />;
      case 'recentlyViewed':
        return <RecentlyViewed title={sec.title} />;
      default:
        return null;
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <AnnouncementTicker messages={cfg.announcement.messages} />
      <Header />
      <FlatList
        data={sections}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item, index }) => <View>{renderSection(item, index)}</View>}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 130 }}
        initialNumToRender={4}
        maxToRenderPerBatch={3}
        windowSize={5}
        removeClippedSubviews={false}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: colors.header,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  logo: { width: 150, height: 40 },
  hIcon: { marginLeft: 18 },
});
