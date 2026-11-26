// Country groups for fiscal position targeting and partner federal state field.
import { ecommerceModels } from './ecommerce.js';

const extend = (base, fields, rest = {}) => ({ ...base, ...rest, fields: { ...base.fields, ...fields } });

export const countryGroupModels = {
  'res.country.group': {
    label: 'Country Groups',
    guard: (_db, _before, after) => (!String(after?.name ?? '').trim() ? 'Country group name is required' : null),
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      country_ids: { type: 'tags', label: 'Countries' },
    },
    defaults: () => ({ country_ids: [] }),
    searchFields: ['name', 'country_ids'],
    list: ['name', 'country_ids'],
    form: {
      title: 'name',
      groups: [['name', 'country_ids'], []],
    },
  },
  'res.partner': extend(ecommerceModels['res.partner'], {
    state: { type: 'char', label: 'State' },
  }, {
    form: {
      ...ecommerceModels['res.partner'].form,
      groups: ecommerceModels['res.partner'].form.groups,
    },
  }),
};
