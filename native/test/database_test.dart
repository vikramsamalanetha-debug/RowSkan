import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:rowskan/store.dart';

void main(){
 TestWidgetsFlutterBinding.ensureInitialized();
 late Directory directory;
 late Store store;
 Map<String,dynamic> vehicle(String id,{String vin=''})=>{'id':id,'vin':vin,'year':'2003','make':'Honda','model':'Accord','status':'Available','photos':<String>[]};
 setUp(() async {directory=await Directory.systemTemp.createTemp('rowskan-test-');store=Store(directory:directory);await store.open();});
 tearDown(() async {await store.db.close();await directory.delete(recursive:true);});
 test('inventory survives closing and reopening its local database',() async {
  await store.save(vehicle('a',vin:'1HGCM82633A004352'));
  await store.db.close();store=Store(directory:directory);await store.open();
  expect((await store.all()).single['make'],'Honda');
 });
 test('duplicate VIN cannot replace an existing vehicle',() async {
  await store.save(vehicle('a',vin:'1HGCM82633A004352'));
  await expectLater(store.save(vehicle('b',vin:'1HGCM82633A004352')),throwsA(anything));
  expect((await store.all()).single['id'],'a');
 });
 test('soft deletion can be restored and stale edits cannot resurrect it',() async {
  final v=vehicle('a');await store.save(v);await store.remove('a');
  expect(await store.all(),isEmpty);
  await expectLater(store.save(v),throwsStateError);
  await store.restoreLast();expect((await store.all()).single['id'],'a');
 });
 test('backup import preserves record and photograph bytes',() async {
  final source=File('${directory.path}/capture.jpg');await source.writeAsBytes([255,216,255,217]);
  final name=await store.copyPhoto(source.path);
  await store.save({...vehicle('a'),'photos':[name]});
  final backup=await store.backup();
  final otherDir=await Directory.systemTemp.createTemp('rowskan-import-');
  final other=Store(directory:otherDir);await other.open();
  try{
   expect(await other.importBackup(backup),1);
   final imported=(await other.all()).single;
   expect(await other.photo((imported['photos'] as List).single as String).readAsBytes(),[255,216,255,217]);
   expect(await other.importBackup(backup),0);
  }finally{await other.db.close();await otherDir.delete(recursive:true);}
 });
}
