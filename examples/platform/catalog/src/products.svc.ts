export interface Product {
  id: string;
  name: string;
  price: number;
}

const PRODUCTS: Product[] = [
  { id: '1', name: 'Mechanical Keyboard', price: 129.99 },
  { id: '2', name: 'Standing Desk', price: 399.0 },
];

export default class ProductsService {
  findAll(): Product[] {
    return PRODUCTS;
  }

  findById(id: string): Product | undefined {
    return PRODUCTS.find((product) => product.id === id);
  }
}
