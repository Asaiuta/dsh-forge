const React = globalThis.__React;
module.exports = {
  Button: 'button', Input: 'input',
  SegmentedTabs({items,value,onChange,label,className}) {
    return React.createElement('nav', {role:'tablist','aria-label':label,'data-native-tabs':label,className}, ...items.map(item => React.createElement('button', {id:item.id,role:'tab','aria-selected':value===item.value,'aria-controls':item.panelId,tabIndex:value===item.value?0:-1,onClick:()=>onChange(item.value)},item.label)));
  }
};
