// src/utils/sanity.ts

import { sanityClient } from 'sanity:client';
import imageUrlBuilder from '@sanity/image-url';

// 将你项目现有的 sanityClient 传给图片构建器
const builder = imageUrlBuilder(sanityClient);

// 导出一个万能的 urlFor 函数，HeroSection 组件就是靠它来压缩图片的！
export function urlFor(source: any) {
  return builder.image(source);
}