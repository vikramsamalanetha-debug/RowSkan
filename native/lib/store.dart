import 'dart:convert';
import 'dart:io';
import 'package:archive/archive.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:uuid/uuid.dart';

const statuses = ['Available', 'In storage', 'For parts', 'Released'];
const vehicleFields = ['vin','year','make','model','color','mileage','location','keys','notes','status'];
bool validVin(String vin) => RegExp(r'^[A-HJ-NPR-Z0-9]{17}$').hasMatch(vin.toUpperCase());
bool canDelete(String mode, {required bool desktop}) => mode == 'solo' || desktop;

class Store {
  final Directory? directory;
  Store({this.directory});
  late Database db;
  late Directory root;
  bool get desktop => Platform.isWindows || Platform.isMacOS || Platform.isLinux;
  Future<void> open() async {
    root = directory ?? Directory(p.join((await getApplicationSupportDirectory()).path, 'RowSkan'));
    await Directory(p.join(root.path,'photos')).create(recursive:true);
    if (desktop) sqfliteFfiInit();
    final factory = desktop ? databaseFactoryFfi : databaseFactory;
    db = await factory.openDatabase(p.join(root.path,'inventory.sqlite'), options:OpenDatabaseOptions(version:1,onCreate:(db,version) async {
      await db.execute('CREATE TABLE vehicles(id TEXT PRIMARY KEY, vin TEXT, data TEXT NOT NULL, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)');
      await db.execute("CREATE UNIQUE INDEX unique_vin ON vehicles(vin) WHERE deleted=0 AND vin IS NOT NULL AND vin<>''");
      await db.execute('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      await db.execute('CREATE TABLE events(id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL)');
    }));
  }
  Future<String> setting(String key, String fallback) async {
    final rows=await db.query('settings',where:'key=?',whereArgs:[key]);
    return rows.isEmpty ? fallback : rows.first['value'] as String;
  }
  Future<void> setSetting(String key,String value) => db.insert('settings',{'key':key,'value':value},conflictAlgorithm:ConflictAlgorithm.replace).then((_){ });
  Future<List<Map<String,dynamic>>> all() async {
    final rows=await db.query('vehicles',where:'deleted=0',orderBy:'updated DESC');
    return rows.map((r)=>Map<String,dynamic>.from(jsonDecode(r['data'] as String) as Map)).toList();
  }
  Future<void> save(Map<String,dynamic> vehicle) async {
    final v=Map<String,dynamic>.from(vehicle);
    v['id'] ??= const Uuid().v4();
    v['vin']=(v['vin']??'').toString().trim().toUpperCase();
    if ((v['make']??'').toString().trim().isEmpty || (v['model']??'').toString().trim().isEmpty) throw StateError('Make and model are required.');
    if ((v['vin'] as String).isNotEmpty && !validVin(v['vin'] as String)) throw StateError('VIN must have 17 characters without I, O or Q. Leave it blank for a manual record.');
    if (!statuses.contains(v['status'])) throw StateError('Choose a valid status.');
    final now=DateTime.now().millisecondsSinceEpoch;
    await db.transaction((t) async {
      final existing=await t.query('vehicles',where:'id=?',whereArgs:[v['id']]);
      if(existing.isNotEmpty && existing.first['deleted']==1) throw StateError('This vehicle was deleted. Restore it first.');
      if(existing.isNotEmpty){
        final old=jsonDecode(existing.first['data'] as String) as Map;
        final settings=await t.query('settings',where:'key=?',whereArgs:['mode']);
        final team=settings.isNotEmpty && settings.first['value']=='team';
        if(team && !desktop){
          final original=(old['photos'] as List? ?? []).cast<String>();
          final next=(v['photos'] as List? ?? []).cast<String>();
          if(!original.every(next.contains)) throw StateError('Saved team photos can only be removed on desktop.');
        }
        await t.update('vehicles',{'vin':v['vin'],'data':jsonEncode(v),'updated':now},where:'id=?',whereArgs:[v['id']]);
      }else{
        await t.insert('vehicles',{'id':v['id'],'vin':v['vin'],'data':jsonEncode(v),'updated':now,'deleted':0});
      }
      await t.insert('events',{'id':const Uuid().v4(),'vehicle_id':v['id'],'kind':existing.isEmpty?'created':'updated','created':now});
    });
  }
  Future<void> remove(String id) async {
    final mode=await setting('mode','solo');
    if(!canDelete(mode,desktop:desktop)) throw StateError('Team records can only be deleted on desktop.');
    await db.transaction((t) async {
      await t.update('vehicles',{'deleted':1,'updated':DateTime.now().millisecondsSinceEpoch},where:'id=?',whereArgs:[id]);
      await t.insert('events',{'id':const Uuid().v4(),'vehicle_id':id,'kind':'deleted','created':DateTime.now().millisecondsSinceEpoch});
    });
  }
  Future<void> restoreLast() async {
    if(!canDelete(await setting('mode','solo'),desktop:desktop)) throw StateError('Restore is desktop-only in team mode.');
    final rows=await db.query('vehicles',where:'deleted=1',orderBy:'updated DESC',limit:1);
    if(rows.isEmpty) throw StateError('No deleted vehicles to restore.');
    await db.update('vehicles',{'deleted':0,'updated':DateTime.now().millisecondsSinceEpoch},where:'id=?',whereArgs:[rows.first['id']]);
  }
  Future<String> copyPhoto(String source) async {
    final extension=p.extension(source).toLowerCase();
    final name='${const Uuid().v4()}${extension.isEmpty?'.jpg':extension}';
    await File(source).copy(p.join(root.path,'photos',name));
    return name;
  }
  File photo(String name) => File(p.join(root.path,'photos',p.basename(name)));
  Future<List<int>> backup() async {
    final archive=Archive();
    final records=await all();
    final payload=utf8.encode(jsonEncode({'format':'rowskan-native','version':1,'vehicles':records}));
    archive.addFile(ArchiveFile('inventory.json',payload.length,payload));
    final names=records.expand((v)=>(v['photos'] as List? ?? []).cast<String>()).toSet();
    for(final name in names){final f=photo(name);if(await f.exists()){final bytes=await f.readAsBytes();archive.addFile(ArchiveFile('photos/${p.basename(name)}',bytes.length,bytes));}}
    return ZipEncoder().encode(archive);
  }
  Future<int> importBackup(List<int> bytes) async {
    if(bytes.length>250*1024*1024) throw StateError('Backup exceeds 250 MB.');
    final archive=ZipDecoder().decodeBytes(bytes);
    final manifest=archive.findFile('inventory.json');
    if(manifest==null) throw StateError('Not a RowSkan native backup.');
    final data=jsonDecode(utf8.decode(manifest.content as List<int>)) as Map;
    if(data['format']!='rowskan-native'||data['version']!=1||data['vehicles'] is! List) throw StateError('Unsupported backup.');
    final records=data['vehicles'] as List;
    if(records.length>10000) throw StateError('Too many records.');
    final known=await db.query('vehicles',columns:['id','vin']);
    final ids=known.map((v)=>v['id']).toSet(), vins=known.map((v)=>v['vin']).where((v)=>v!='').toSet();
    var added=0, total=0;
    for(final item in records){
      final v=Map<String,dynamic>.from(item as Map);
      if(v['id'] is! String || v['make'] is! String || v['model'] is! String) throw StateError('Invalid vehicle.');
      if(ids.contains(v['id']) || ((v['vin']??'')!='' && vins.contains(v['vin']))) continue;
      final photos=v['photos'] as List? ?? [];
      if(photos.length>12) throw StateError('Invalid photo count.');
      final copied=<String>[];
      for(final name in photos){
        if(name is! String || p.basename(name)!=name) throw StateError('Invalid photo name.');
        final file=archive.findFile('photos/$name');
        if(file==null || file.size>25*1024*1024) throw StateError('Missing or oversized photo.');
        total+=file.size;if(total>500*1024*1024) throw StateError('Expanded backup too large.');
        final fresh='${const Uuid().v4()}${p.extension(name)}';
        await photo(fresh).writeAsBytes(file.content as List<int>,flush:true);copied.add(fresh);
      }
      v['photos']=copied;
      await save(v);ids.add(v['id']);if((v['vin']??'')!='')vins.add(v['vin']);added++;
    }
    return added;
  }
}
