const express = require('express');
const multer = require('multer');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 配置
// ============================================================
const CONFIG = {
  shopifyStore: process.env.SHOPIFY_STORE || 'angedodge.myshopify.com',
  shopifyToken: process.env.SHOPIFY_TOKEN || '',
  shopifyApiVersion: '2026-04',
  openaiApiKey: (process.env.OPENAI_API_KEY || '').trim(),
  // 走量定价: RMB / 汇率 * 倍率
  exchangeRate: 7.25,
  priceMultiplier: 0.75, // 走量策略，约等于 RMB/7.25 * 0.75 → ~$60-70 for ¥598
  compareAtMultiplier: 1.05, // 划线价再高 40%
};

// 图片上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Buffer.from(file.originalname, 'latin1').toString('utf8')),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ============================================================
// OpenAI Vision - 从截图识别商品信息
// ============================================================
async function analyzeScreenshot(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const requestBody = {
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `你是一个电商产品信息提取专家。从抖店/电商平台的产品截图中提取商品信息，并直接翻译成适合北美市场的英文。

输出严格按照以下 JSON 格式（不要输出其他内容）：
{
  "title_cn": "中文标题",
  "title_en": "English title optimized for US market SEO",
  "description_en": "Detailed English product description with features, material, occasions (HTML format with <h3> and <ul> tags)",
  "price_rmb": 数字,
  "colors_cn": ["颜色1", "颜色2"],
  "colors_en": ["Color1", "Color2"],
  "sizes": ["M", "L", "XL", "2XL", "3XL"],
  "material_cn": "材质中文",
  "material_en": "Material in English",
  "category": "product category in English",
  "tags": "comma separated English tags for SEO"
}`
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请从这张电商平台截图中提取商品信息，翻译成英文，按要求的JSON格式输出。' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
        ]
      }
    ],
    max_tokens: 2000,
    temperature: 0.3,
  };

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(requestBody);
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.openaiApiKey}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(result.error.message));
            return;
          }
          const content = result.choices[0].message.content;
          // Extract JSON from response (handle markdown code blocks)
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            resolve(JSON.parse(jsonMatch[0]));
          } else {
            reject(new Error('Failed to parse AI response'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ============================================================
// 多张截图分析
// ============================================================
async function analyzeMultipleScreenshots(imagePaths) {
  const imageContents = imagePaths.map(p => {
    const imageBuffer = fs.readFileSync(p);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } };
  });

  const requestBody = {
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `你是一个电商产品信息提取专家。从多张抖店/电商平台的产品截图中提取完整的商品信息，并直接翻译成适合北美市场的英文。

综合所有截图的信息，输出严格按照以下 JSON 格式（不要输出其他内容）：
{
  "title_cn": "中文标题",
  "title_en": "English title optimized for US market SEO (under 70 chars)",
  "description_en": "Detailed English product description in HTML format. Include: <h2> main title, <h3> sections for Features, Size Guide (as <table>), Material & Care, Styling Suggestions, FAQ. Make it GEO-optimized with specific numbers and facts. In the FAQ section, use exactly this shipping info: Processing time: 1-3 business days. Delivery to US: 6-12 business days (via YunExpress international shipping).",
  "price_rmb": 数字(不含¥符号),
  "colors_cn": ["颜色1", "颜色2"],
  "colors_en": ["Color1", "Color2"],
  "sizes": ["S", "M", "L", "XL", "2XL"],
  "material_cn": "材质中文",
  "material_en": "55% Linen, 45% Cotton (example format)",
  "category": "Jackets",
  "tags": "mens jacket, casual jacket, spring jacket, lightweight jacket (10-15 SEO tags)",
  "weight_kg": 0.5
}`
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请从这些电商平台截图中提取完整的商品信息，综合所有截图，翻译成英文，按要求的JSON格式输出。' },
          ...imageContents
        ]
      }
    ],
    max_tokens: 3000,
    temperature: 0.3,
  };

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(requestBody);
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.openaiApiKey}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(result.error.message));
            return;
          }
          const content = result.choices[0].message.content;
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            resolve(JSON.parse(jsonMatch[0]));
          } else {
            reject(new Error('Failed to parse AI response'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ============================================================
// 定价计算
// ============================================================
function calculatePricing(priceRmb) {
  const baseUsd = priceRmb / CONFIG.exchangeRate;
  const sellingPrice = Math.ceil(baseUsd * CONFIG.priceMultiplier) - 0.01;
  const compareAt = Math.ceil(baseUsd * CONFIG.compareAtMultiplier) - 0.01;
  return {
    price: sellingPrice.toFixed(2),
    compareAtPrice: compareAt.toFixed(2),
  };
}

// ============================================================
// 上传到 Shopify
// ============================================================
async function uploadToShopify(productInfo, productImages) {
  const pricing = calculatePricing(productInfo.price_rmb);

  const product = {
    product: {
      title: productInfo.title_en,
      body_html: productInfo.description_en,
      vendor: 'ANGEDODGE',
      product_type: productInfo.category || 'Clothing',
      tags: productInfo.tags || '',
      status: 'draft',
      options: [
        { name: 'Color', values: productInfo.colors_en },
        { name: 'Size', values: productInfo.sizes }
      ],
      variants: [],
      images: [],
      metafields_global_title_tag: `${productInfo.title_en} – ANGEDODGE`,
      metafields_global_description_tag: productInfo.description_en.replace(/<[^>]*>/g, '').substring(0, 155),
    }
  };

  // Generate variants
  for (const color of productInfo.colors_en) {
    for (const size of productInfo.sizes) {
      const colorCode = color.replace(/\s+/g, '').substring(0, 2).toUpperCase();
      product.product.variants.push({
        option1: color,
        option2: size,
        price: pricing.price,
        compare_at_price: pricing.compareAtPrice,
        sku: `${productInfo.category ? productInfo.category.substring(0, 3).toUpperCase() : 'PRD'}-${colorCode}-${size}`,
        inventory_management: 'shopify',
        inventory_quantity: 50,
        requires_shipping: true,
        weight: productInfo.weight_kg || 0.5,
        weight_unit: 'kg',
      });
    }
  }

  // Add product images as base64
  for (const imgPath of productImages.slice(0, 10)) {
    try {
      const imageData = fs.readFileSync(imgPath);
      const base64 = imageData.toString('base64');
      const filename = path.basename(imgPath);
      product.product.images.push({ attachment: base64, filename });
    } catch (e) {
      console.error(`Failed to read image: ${imgPath}`);
    }
  }

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(product);
    const options = {
      hostname: CONFIG.shopifyStore,
      path: `/admin/api/${CONFIG.shopifyApiVersion}/products.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': CONFIG.shopifyToken,
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.product) {
            resolve(result.product);
          } else {
            reject(new Error(JSON.stringify(result.errors || result)));
          }
        } catch (e) {
          reject(new Error(data.substring(0, 500)));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ============================================================
// API 路由
// ============================================================

// 分析截图
app.post('/api/analyze', upload.array('screenshots', 10), async (req, res) => {
  try {
    if (!CONFIG.openaiApiKey) {
      return res.status(400).json({ error: 'OpenAI API Key not configured. Set OPENAI_API_KEY environment variable.' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No screenshots uploaded' });
    }

    const imagePaths = req.files.map(f => f.path);
    console.log(`📸 Analyzing ${imagePaths.length} screenshots...`);

    let productInfo;
    if (imagePaths.length === 1) {
      productInfo = await analyzeScreenshot(imagePaths[0]);
    } else {
      productInfo = await analyzeMultipleScreenshots(imagePaths);
    }

    // Calculate pricing
    const pricing = calculatePricing(productInfo.price_rmb);
    productInfo.price_usd = pricing.price;
    productInfo.compare_at_price_usd = pricing.compareAtPrice;

    console.log(`✅ Product identified: ${productInfo.title_cn} → ${productInfo.title_en}`);
    console.log(`💰 Price: ¥${productInfo.price_rmb} → $${pricing.price}`);

    res.json({ success: true, productInfo });
  } catch (error) {
    console.error('❌ Analysis error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 上传到 Shopify
app.post('/api/upload', upload.array('images', 20), async (req, res) => {
  try {
    const productInfo = JSON.parse(req.body.productInfo);
    const imagePaths = req.files ? req.files.map(f => f.path) : [];

    console.log(`📦 Uploading to Shopify: ${productInfo.title_en}`);

    const product = await uploadToShopify(productInfo, imagePaths);

    console.log(`✅ Product created! ID: ${product.id}`);

    // Cleanup uploaded files
    for (const f of (req.files || [])) {
      fs.unlink(f.path, () => {});
    }

    res.json({
      success: true,
      product: {
        id: product.id,
        title: product.title,
        status: product.status,
        variants: product.variants.length,
        images: product.images.length,
        url: `https://admin.shopify.com/store/angedodge/products/${product.id}`,
      }
    });
  } catch (error) {
    console.error('❌ Upload error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 启动
// ============================================================
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n🚀 商品上架工具已启动！`);
  console.log(`📍 打开浏览器访问: http://localhost:${PORT}`);
  console.log(`\n配置信息:`);
  console.log(`   Shopify: ${CONFIG.shopifyStore}`);
  console.log(`   OpenAI: ${CONFIG.openaiApiKey ? '✅ 已配置' : '❌ 未配置 (设置 OPENAI_API_KEY 环境变量)'}`);
  console.log(`   定价策略: 走量 (RMB ÷ ${CONFIG.exchangeRate} × ${CONFIG.priceMultiplier})\n`);
});
